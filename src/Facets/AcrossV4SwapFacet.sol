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
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title AcrossV4SwapFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across Protocol using the Swap API (SpokePoolPeriphery)
/// @custom:version 1.0.0
contract AcrossV4SwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the SpokePoolPeriphery on the source chain
    ISpokePoolPeriphery public immutable SPOKE_POOL_PERIPHERY;

    /// @notice The contract address of the SpokePool on the source chain
    address public immutable SPOKE_POOL;

    /// Types ///

    /// @notice Data specific to Across V4 Swap API bridging
    /// @param depositData Core deposit parameters for the Across bridge
    /// @param swapToken The token to swap from on the source chain
    /// @param exchange The DEX router address to execute the swap
    /// @param transferType How to transfer tokens to the exchange (Approval, Transfer, Permit2Approval)
    /// @param routerCalldata The calldata to execute on the DEX router
    /// @param minExpectedInputTokenAmount Minimum amount of bridgeable token expected after swap
    /// @param enableProportionalAdjustment If true, adjusts outputAmount proportionally based on swap results
    struct AcrossV4SwapData {
        ISpokePoolPeriphery.BaseDepositData depositData;
        address swapToken;
        address exchange;
        ISpokePoolPeriphery.TransferType transferType;
        bytes routerCalldata;
        uint256 minExpectedInputTokenAmount;
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
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        _startBridge(_bridgeData, _acrossV4SwapData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for bridging via Across Swap API
    /// @param _bridgeData The core information needed for bridging
    /// @param _acrossV4SwapData Data specific to Across V4 Swap API
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        AcrossV4SwapData calldata _acrossV4SwapData
    ) internal {
        // Approve the periphery to spend tokens
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(SPOKE_POOL_PERIPHERY),
            _bridgeData.minAmount
        );

        // Build the SwapAndDepositData struct for the periphery
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
        SPOKE_POOL_PERIPHERY.swapAndBridge(swapAndDepositData);

        emit LiFiTransferStarted(_bridgeData);
    }
}
