// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAcrossSpokePoolV4 } from "../Interfaces/IAcrossSpokePoolV4.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InformationMismatch, InvalidNonEVMReceiver, InvalidReceiver, InvalidConfig } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

/// @title AcrossFacetV4
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across Protocol
/// @custom:version 1.0.0
contract AcrossFacetV4 is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    /// @notice The contract address of the spoke pool on the source chain.
    IAcrossSpokePoolV4 public immutable SPOKEPOOL;

    /// @notice The WETH address on the current chain.
    bytes32 public immutable WRAPPED_NATIVE;

    /// @notice The Across custom chain ID for Solana
    uint256 public constant ACROSS_CHAIN_ID_SOLANA = 34268394551451;

    /// Types ///

    /// @param receiverAddress The address that will receive the token on dst chain
    ///                        (our Receiver contract or the user-defined receiver address)
    /// @param refundAddress The address that will be used for potential bridge refunds
    /// @param sendingAssetId The address of the token to be sent from source chain
    /// @param receivingAssetId The address of the token to be received at destination chain
    /// @param outputAmount The amount to be received at destination chain (after fees)
    /// @param outputAmountMultiplier In case of pre-bridge swaps we need to adjust the output amount
    /// @param exclusiveRelayer This is the exclusive relayer who can fill the deposit before the exclusivity deadline.
    /// @param quoteTimestamp The timestamp of the Across quote that was used for this transaction
    /// @param fillDeadline The destination chain timestamp until which the order can be filled
    /// @param exclusivityDeadline The timestamp on the destination chain after which any relayer can fill the deposit
    /// @param message Arbitrary data that can be used to pass additional information to the recipient along with the tokens
    struct AcrossV4Data {
        bytes32 receiverAddress;
        bytes32 refundAddress;
        bytes32 sendingAssetId;
        bytes32 receivingAssetId;
        uint256 outputAmount;
        uint128 outputAmountMultiplier;
        bytes32 exclusiveRelayer;
        uint32 quoteTimestamp;
        uint32 fillDeadline;
        uint32 exclusivityDeadline;
        bytes message;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _spokePool The contract address of the spoke pool on the source chain.
    /// @param _wrappedNative The address of the wrapped native token on the source chain.
    constructor(IAcrossSpokePoolV4 _spokePool, bytes32 _wrappedNative) {
        if (
            address(_spokePool) == address(0) || _wrappedNative == bytes32(0)
        ) {
            revert InvalidConfig();
        }

        SPOKEPOOL = _spokePool;
        WRAPPED_NATIVE = _wrappedNative;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function startBridgeTokensViaAcrossV4(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4Data calldata _acrossData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _acrossData);
    }

    /// @notice Performs a swap before bridging via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _acrossData data specific to Across
    function swapAndStartBridgeTokensViaAcrossV4(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AcrossV4Data calldata _acrossData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        // Since the minAmount / inputAmount was updated, we also need to adjust the outputAmount.
        // In case any of different decimals between input and output, we will adjust the outputAmount
        // with the outputAmountMultiplier to account for the difference in decimals. We divide by 1e18
        // to allow room for adjustment in both directions, i.e. from 6 > 18 decimals and vice versa.
        // The multiplier should be calculated as:  multiplierPercentage * 1e18 * 10^(outputDecimals - inputDecimals)
        AcrossV4Data memory modifiedAcrossData = _acrossData;
        modifiedAcrossData.outputAmount =
            (_bridgeData.minAmount * _acrossData.outputAmountMultiplier) /
            1e18;

        _startBridge(_bridgeData, modifiedAcrossData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4Data memory _acrossData
    ) internal {
        // validate destination call flag
        if (_acrossData.message.length > 0 != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }

        // get across (custom) destination chain id, if applicable
        uint256 destinationChainId = _getAcrossChainId(
            _bridgeData.destinationChainId
        );

        // validate receiver address
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            // destination chain is non-EVM
            // make sure it's non-zero (we cannot validate further)
            if (_acrossData.receiverAddress == bytes32(0)) {
                revert InvalidNonEVMReceiver();
            }

            // emit event for non-EVM chain
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _acrossData.receiverAddress
            );
        } else {
            // destination chain is EVM
            // make sure that bridgeData and acrossData receiver addresses match, but only
            // if there is no destination call, cause in case of destination call the receiver
            // address is the our receiver contract address and not the user-defined receiver address
            if (
                !_bridgeData.hasDestinationCall &&
                _convertAddressToBytes32(_bridgeData.receiver) !=
                _acrossData.receiverAddress
            ) revert InvalidReceiver();

            if (_acrossData.receiverAddress == bytes32(0)) {
                revert InvalidReceiver();
            }
        }

        // check if sendingAsset is native or ERC20
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // NATIVE
            SPOKEPOOL.deposit{ value: _bridgeData.minAmount }(
                _acrossData.refundAddress, // depositor (also acts as refund address in case release tx cannot be executed)
                _acrossData.receiverAddress, // recipient (on dst)
                WRAPPED_NATIVE, // inputToken
                _acrossData.receivingAssetId, // outputToken
                _bridgeData.minAmount, // inputAmount
                _acrossData.outputAmount, // outputAmount
                destinationChainId, // destinationChainId
                _acrossData.exclusiveRelayer, // exclusiveRelayer
                _acrossData.quoteTimestamp, // quoteTimestamp
                _acrossData.fillDeadline, // fillDeadline
                _acrossData.exclusivityDeadline, // exclusivityDeadline
                _acrossData.message // message
            );
        } else {
            // ERC20
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(SPOKEPOOL),
                _bridgeData.minAmount
            );
            SPOKEPOOL.deposit(
                _acrossData.refundAddress, // depositor (also acts as refund address in case release tx cannot be executed)
                _acrossData.receiverAddress, // recipient (on dst)
                _acrossData.sendingAssetId, // inputToken (now from acrossData)
                _acrossData.receivingAssetId, // outputToken
                _bridgeData.minAmount, // inputAmount
                _acrossData.outputAmount, // outputAmount
                destinationChainId, // destinationChainId
                _acrossData.exclusiveRelayer, // exclusiveRelayer
                _acrossData.quoteTimestamp, // quoteTimestamp
                _acrossData.fillDeadline, // fillDeadline
                _acrossData.exclusivityDeadline, // exclusivityDeadline
                _acrossData.message // message
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Converts LiFi internal (non-EVM) chain IDs to Across chain IDs
    ///         For EVM chainIds there is no need to convert, they will just returned as-is
    /// @param _destinationChainId The LiFi chain ID to convert
    function _getAcrossChainId(
        uint256 _destinationChainId
    ) internal pure returns (uint256) {
        // currently only Solana has a custom chainId
        if (_destinationChainId == LIFI_CHAIN_ID_SOLANA) {
            return ACROSS_CHAIN_ID_SOLANA;
        } else {
            return _destinationChainId;
        }
    }

    /// @notice Converts an address to a bytes32
    /// @param _address The address to convert
    function _convertAddressToBytes32(
        address _address
    ) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(_address)));
    }
}
