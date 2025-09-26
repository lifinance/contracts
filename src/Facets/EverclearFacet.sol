// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IEverclearFeeAdapter } from "../Interfaces/IEverclearFeeAdapter.sol";
import { InvalidCallData, InvalidConfig } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

/// @title Everclear Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Everclear
/// @custom:version 1.0.0
contract EverclearFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    /// Storage ///

    IEverclearFeeAdapter public immutable FEE_ADAPTER;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param exampleParam Example parameter
    struct EverclearData {
        bytes32 receiverAddress;
        bytes32 outputAsset;
        uint24 maxFee;
        uint48 ttl;
        bytes data;
        uint256 fee;
        uint256 deadline;
        bytes sig;
    }

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _feeAdapter Fee adapter address.
    constructor(address _feeAdapter) {
        if (address(_feeAdapter) == address(0)) {
            revert InvalidConfig();
        }
        FEE_ADAPTER = IEverclearFeeAdapter(_feeAdapter);
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
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount + _everclearData.fee
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
        if (_everclearData.receiverAddress == bytes32(0) 
        || _everclearData.outputAsset == bytes32(0))
            revert InvalidCallData();

        // Handle native vs. ERC20
        uint256 value;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            value = _bridgeData.minAmount;
        } else {
            // Approve the fee adapter to pull the required amount
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(FEE_ADAPTER),
                _bridgeData.minAmount
            );
        }

        IEverclearFeeAdapter.FeeParams memory feeParams = IEverclearFeeAdapter.FeeParams({
            fee: _everclearData.fee,
            deadline: _everclearData.deadline,
            sig: _everclearData.sig
        });

        uint32[] memory destinationChainIds = new uint32[](1);
        destinationChainIds[0] = uint32(_bridgeData.destinationChainId);

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            FEE_ADAPTER.newIntent{ value: value }(
                destinationChainIds,
                _everclearData.receiverAddress,
                _bridgeData.sendingAssetId,
                _everclearData.outputAsset,
                _bridgeData.minAmount,
                _everclearData.maxFee,
                _everclearData.ttl,
                _everclearData.data,
                feeParams
            );

            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _everclearData.receiverAddress
            );
        } else {
            FEE_ADAPTER.newIntent{ value: value }(
                destinationChainIds,
                bytes32(uint256(uint160(_bridgeData.receiver))),
                _bridgeData.sendingAssetId,
                _everclearData.outputAsset,
                _bridgeData.minAmount,
                _everclearData.maxFee,
                _everclearData.ttl,
                _everclearData.data,
                feeParams
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
