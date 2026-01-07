// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ISpokePoolPeriphery } from "../Interfaces/ISpokePoolPeriphery.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig, InformationMismatch, InvalidReceiver, InvalidNonEVMReceiver, InvalidCallData } from "../Errors/GenericErrors.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

/// @title AcrossV4SwapFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across Protocol using the Swap API (SpokePoolPeriphery)
/// @dev This contract does not custody user funds. Any native tokens received are either forwarded
///      to the SpokePoolPeriphery or refunded to the sender via the refundExcessNative modifier.
/// @custom:version 1.0.1
contract AcrossV4SwapFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    /// @notice The contract address of the SpokePoolPeriphery on the source chain
    ISpokePoolPeriphery public immutable SPOKE_POOL_PERIPHERY;

    /// @notice The contract address of the SpokePool on the source chain
    address public immutable SPOKE_POOL;

    /// @notice The Across custom chain ID for Solana
    uint256 public constant ACROSS_CHAIN_ID_SOLANA = 34268394551451;

    /// @notice The base for the outputAmountMultiplier (to allow room for adjustments in both directions)
    uint256 public constant MULTIPLIER_BASE = 1e18;

    /// Types ///

    /// @notice Data specific to Across V4 Swap API bridging
    /// @param depositData Core deposit parameters for the Across bridge
    /// @param swapToken The token to swap from on the source chain
    /// @param exchange The DEX router address to execute the swap
    /// @param transferType How to transfer tokens to the exchange (Approval, Transfer, Permit2Approval)
    /// @param routerCalldata The calldata to execute on the DEX router
    /// @param minExpectedInputTokenAmount Minimum amount of bridgeable token expected after swap
    /// @param outputAmountMultiplier Multiplier used to adjust outputAmount when positive slippage occurs after a swap.
    ///                               Accounts for decimal differences between bridge input and output tokens.
    ///                               Formula: multiplierPercentage * 1e18 * 10^(outputDecimals - inputDecimals).
    ///                               For same decimals, use 1e18 (100% multiplier). Only applied when minAmount > originalAmount.
    /// @param enableProportionalAdjustment If true, adjusts outputAmount proportionally based on swap results
    struct AcrossV4SwapData {
        ISpokePoolPeriphery.BaseDepositData depositData;
        address swapToken;
        address exchange;
        ISpokePoolPeriphery.TransferType transferType;
        bytes routerCalldata;
        uint256 minExpectedInputTokenAmount;
        uint128 outputAmountMultiplier;
        bool enableProportionalAdjustment;
    }

    /// Constructor ///

    /// @notice Initialize the contract
    /// @param _spokePoolPeriphery The contract address of the SpokePoolPeriphery
    /// @param _spokePool The contract address of the SpokePool
    constructor(ISpokePoolPeriphery _spokePoolPeriphery, address _spokePool) {
        if (
            address(_spokePoolPeriphery) == address(0) ||
            _spokePool == address(0)
        ) {
            revert InvalidConfig();
        }
        SPOKE_POOL_PERIPHERY = _spokePoolPeriphery;
        SPOKE_POOL = _spokePool;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Across using the Swap API
    /// @param _bridgeData The core information needed for bridging
    /// @param _acrossV4SwapData Data specific to Across V4 Swap API
    function startBridgeTokensViaAcrossV4Swap(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4SwapData calldata _acrossV4SwapData
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
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _acrossV4SwapData);
    }

    /// @notice Performs a swap before bridging via Across using the Swap API
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _acrossV4SwapData Data specific to Across V4 Swap API
    function swapAndStartBridgeTokensViaAcrossV4Swap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AcrossV4SwapData calldata _acrossV4SwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // deposit funds and execute swaps / fee collection, if applicable
        uint256 originalAmount = _bridgeData.minAmount;
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        // Update outputAmount and minExpectedInputTokenAmount proportionally if there was positive slippage
        // If minAmount == originalAmount, no adjustment is needed as the outputAmount is already correct
        // In case of different decimals between input and output, we will adjust the outputAmount
        // with the outputAmountMultiplier to account for the difference in decimals. We divide by 1e18
        // to allow room for adjustment in both directions, i.e. from 6 > 18 decimals and vice versa.
        // The multiplier should be calculated as:  multiplierPercentage * 1e18 * 10^(outputDecimals - inputDecimals)
        // NOTE: please note that we intentionally do not verify the outputAmount any further. Only use LI.FI backend-
        //       generated calldata to avoid potential loss of funds.
        AcrossV4SwapData memory updatedAcrossData = _acrossV4SwapData;
        if (_bridgeData.minAmount > originalAmount) {
            updatedAcrossData.depositData.outputAmount =
                (_bridgeData.minAmount *
                    _acrossV4SwapData.outputAmountMultiplier) /
                MULTIPLIER_BASE;

            updatedAcrossData.minExpectedInputTokenAmount =
                (_acrossV4SwapData.minExpectedInputTokenAmount *
                    _bridgeData.minAmount) /
                originalAmount;
        }

        _startBridge(_bridgeData, updatedAcrossData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for bridging via Across Swap API
    /// @param _bridgeData The core information needed for bridging
    /// @param _acrossV4SwapData Data specific to Across V4 Swap API
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4SwapData memory _acrossV4SwapData
    ) internal {
        // validate receiver address and destination chain IDs
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            // destination chain is non-EVM
            // validate destination chain IDs match (convert LiFi chain ID to Across chain ID for comparison)
            uint256 expectedAcrossChainId = _getAcrossChainId(
                _bridgeData.destinationChainId
            );
            if (
                _acrossV4SwapData.depositData.destinationChainId !=
                expectedAcrossChainId
            ) {
                revert InformationMismatch();
            }

            // make sure recipient is non-zero (we cannot validate further)
            if (_acrossV4SwapData.depositData.recipient == bytes32(0)) {
                revert InvalidNonEVMReceiver();
            }

            // emit event for non-EVM chain
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _acrossV4SwapData.depositData.recipient
            );
        } else {
            // destination chain is EVM
            // validate destination chain IDs match (for EVM chains, chain IDs match directly)
            if (
                _acrossV4SwapData.depositData.destinationChainId !=
                _bridgeData.destinationChainId
            ) {
                revert InformationMismatch();
            }

            // For the Swap API, depositData.recipient is always the multicall handler contract that executes
            // the swap and forwards tokens to the actual recipient. The final recipient is encoded in
            // routerCalldata or message (which is used by Across API for their own calldata, not for
            // destination calls). We trust the LI.FI backend to ensure the final recipient matches
            // bridgeData.receiver. We only validate that recipient is non-zero to prevent lost funds.
            if (_acrossV4SwapData.depositData.recipient == bytes32(0)) {
                revert InvalidReceiver();
            }
        }

        // validate refund address to prevent loss of funds in case of refunds
        if (_acrossV4SwapData.depositData.depositor == address(0)) {
            revert InvalidCallData();
        }

        // determine if msg.value or ERC20 approval is needed
        uint256 msgValue;
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // NATIVE
            // determine how many native tokens will be sent to the Spokepool periphery
            msgValue = _bridgeData.minAmount;
        } else {
            // ERC20
            // Approve the Spokepool periphery to spend tokens
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(SPOKE_POOL_PERIPHERY),
                _bridgeData.minAmount
            );
        }

        // Build the SwapAndDepositData struct for the periphery (same for native and ERC20)
        ISpokePoolPeriphery.SwapAndDepositData
            memory swapAndDepositData = ISpokePoolPeriphery
                .SwapAndDepositData({
                    submissionFees: ISpokePoolPeriphery.Fees({
                        amount: 0,
                        recipient: address(0)
                    }),
                    depositData: _acrossV4SwapData.depositData,
                    swapToken: _acrossV4SwapData.swapToken,
                    exchange: _acrossV4SwapData.exchange,
                    transferType: _acrossV4SwapData.transferType,
                    swapTokenAmount: _bridgeData.minAmount,
                    minExpectedInputTokenAmount: _acrossV4SwapData
                        .minExpectedInputTokenAmount,
                    routerCalldata: _acrossV4SwapData.routerCalldata,
                    enableProportionalAdjustment: _acrossV4SwapData
                        .enableProportionalAdjustment,
                    spokePool: SPOKE_POOL,
                    nonce: 0 // Not used in gasful flow
                });

        // Call the periphery's swapAndBridge function
        SPOKE_POOL_PERIPHERY.swapAndBridge{ value: msgValue }(
            swapAndDepositData
        );

        // Emit event after external call completes successfully
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
}
