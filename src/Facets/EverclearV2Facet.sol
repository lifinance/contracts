// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IEverclearFeeAdapterV2 } from "../Interfaces/IEverclearFeeAdapterV2.sol";
import { InvalidCallData, InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

/// @title EverclearV2Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Everclear
/// @custom:version 1.0.0
contract EverclearV2Facet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    /// @notice The contract address of the Everclear fee adapter.
    IEverclearFeeAdapterV2 public immutable FEE_ADAPTER_V2;

    /// Constants ///
    uint32 internal constant EVERCLEAR_CHAIN_ID_SOLANA = 1399811149;

    /// Types ///

    /// @param receiverAddress The address of the receiver
    /// @param outputAsset The address of the output asset
    /// @param amountOutMin The minimum amount out
    /// @param ttl The time to live
    /// @param data The data
    /// @param fee The fee
    /// @param deadline The deadline
    /// @param sig The signature
    struct EverclearData {
        bytes32 receiverAddress;
        uint256 nativeFee;
        bytes32 outputAsset;
        uint256 amountOutMin;
        uint48 ttl;
        bytes data;
        uint256 fee;
        uint256 deadline;
        bytes sig;
    }

    /// Errors ///

    /// @notice Reverts when the destination chain is not supported by Everclear
    error UnsupportedEverclearChainId();

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _feeAdapterV2 Fee adapter address.
    constructor(address _feeAdapterV2) {
        if (address(_feeAdapterV2) == address(0)) {
            revert InvalidConfig();
        }
        FEE_ADAPTER_V2 = IEverclearFeeAdapterV2(_feeAdapterV2);
    }

    /// External Methods ///

    /// @notice Bridges tokens via Everclear
    /// @param _bridgeData The core information needed for bridging
    /// @param _everclearData Data specific to Everclear
    function startBridgeTokensViaEverclear(
        ILiFi.BridgeData memory _bridgeData,
        EverclearData calldata _everclearData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _everclearData);
    }

    /// @notice Performs a swap before bridging via Everclear
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _everclearData Data specific to Everclear
    function swapAndStartBridgeTokensViaEverclear(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        EverclearData calldata _everclearData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _everclearData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Everclear
    /// @param _bridgeData The core information needed for bridging
    /// @param _everclearData Data specific to Everclear
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EverclearData calldata _everclearData
    ) internal {
        // make sure receiver address has a value to prevent potential loss of funds
        // contract does NOT validate _everclearData.deadline and _everclearData.sig to save gas here. Fee adapter will signature with fee and deadline in message anyway.
        if (_everclearData.outputAsset == bytes32(0)) revert InvalidCallData();

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(FEE_ADAPTER_V2),
            _bridgeData.minAmount
        );

        // validate receiver address
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            // make sure it's non-zero (we cannot validate further)
            if (_everclearData.receiverAddress == bytes32(0)) {
                revert InvalidNonEVMReceiver();
            }

            uint32[] memory destinationChainIds = new uint32[](1);
            if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_SOLANA) {
                destinationChainIds[0] = EVERCLEAR_CHAIN_ID_SOLANA;
            } else {
                revert UnsupportedEverclearChainId();
            }

            // destination chain is non-EVM
            FEE_ADAPTER_V2.newIntent{ value: _everclearData.nativeFee }( // value is ONLY the fee for the intent, FEE_ADAPTER_V2 does NOT handle the native token as an asset
                destinationChainIds,
                _everclearData.receiverAddress,
                _bridgeData.sendingAssetId,
                _everclearData.outputAsset,
                _bridgeData.minAmount - _everclearData.fee, // fee is deducted from the minAmount and it's pulled from the sender separately
                _everclearData.amountOutMin,
                _everclearData.ttl,
                _everclearData.data,
                IEverclearFeeAdapterV2.FeeParams({
                    fee: _everclearData.fee,
                    deadline: _everclearData.deadline,
                    sig: _everclearData.sig
                })
            );

            // emit event for non-EVM chain
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _everclearData.receiverAddress
            );
        } else {
            // destination chain is EVM
            // make sure that bridgeData and everclearData receiver addresses match
            if (
                bytes32(uint256(uint160(_bridgeData.receiver))) !=
                _everclearData.receiverAddress
            ) revert InvalidReceiver();

            uint32[] memory destinationChainIds = new uint32[](1);
            destinationChainIds[0] = uint32(_bridgeData.destinationChainId);

            FEE_ADAPTER_V2.newIntent{ value: _everclearData.nativeFee }( // value is ONLY the fee for the intent, FEE_ADAPTER_V2 does NOT handle the native token as an asset
                destinationChainIds,
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                address(uint160(uint256(_everclearData.outputAsset))),
                _bridgeData.minAmount - _everclearData.fee, // fee is deducted from the minAmount and it's pulled from the sender separately
                _everclearData.amountOutMin,
                _everclearData.ttl,
                _everclearData.data,
                IEverclearFeeAdapterV2.FeeParams({
                    fee: _everclearData.fee,
                    deadline: _everclearData.deadline,
                    sig: _everclearData.sig
                })
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
