// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IXDaiBridge } from "../Interfaces/IXDaiBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount } from "../Errors/GenericErrors.sol";
import { InvalidAmount, InvalidSendingToken, InvalidDestinationChain, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title Gnosis Bridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through XDaiBridge
contract GnosisBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Storage ///

    address internal constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    uint64 internal constant GNOSIS_CHAIN_ID = 100;

    /// Types ///

    struct GnosisBridgeData {
        address xDaiBridge;
        address receiver;
        uint256 amount;
    }

    /// External Methods ///

    /// @notice Bridges tokens via XDaiBridge
    /// @param lifiData data used purely for tracking and analytics
    /// @param gnosisBridgeData data specific to bridge
    function startBridgeTokensViaXDaiBridge(LiFiData calldata lifiData, GnosisBridgeData calldata gnosisBridgeData)
        external
        payable
        nonReentrant
    {
        if (lifiData.destinationChainId != GNOSIS_CHAIN_ID) {
            revert InvalidDestinationChain();
        }
        if (lifiData.sendingAssetId != DAI) {
            revert InvalidSendingToken();
        }
        if (gnosisBridgeData.amount == 0) {
            revert InvalidAmount();
        }
        if (LibUtil.isZeroAddress(gnosisBridgeData.receiver)) {
            revert InvalidReceiver();
        }

        LibAsset.depositAsset(DAI, gnosisBridgeData.amount);

        _startBridge(gnosisBridgeData);

        emit LiFiTransferStarted(
            lifiData.transactionId,
            "gnosis",
            "",
            lifiData.integrator,
            lifiData.referrer,
            lifiData.sendingAssetId,
            lifiData.receivingAssetId,
            gnosisBridgeData.receiver,
            gnosisBridgeData.amount,
            lifiData.destinationChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via XDaiBridge
    /// @param lifiData data used purely for tracking and analytics
    /// @param swapData an array of swap related data for performing swaps before bridging
    /// @param gnosisBridgeData data specific to bridge
    function swapAndStartBridgeTokensViaXDaiBridge(
        LiFiData calldata lifiData,
        LibSwap.SwapData[] calldata swapData,
        GnosisBridgeData memory gnosisBridgeData
    ) external payable nonReentrant {
        if (lifiData.destinationChainId != GNOSIS_CHAIN_ID) {
            revert InvalidDestinationChain();
        }
        if (lifiData.sendingAssetId != DAI || swapData[swapData.length - 1].receivingAssetId != DAI) {
            revert InvalidSendingToken();
        }
        if (LibUtil.isZeroAddress(gnosisBridgeData.receiver)) {
            revert InvalidReceiver();
        }

        gnosisBridgeData.amount = _executeAndCheckSwaps(lifiData, swapData, payable(msg.sender));

        if (gnosisBridgeData.amount == 0) {
            revert InvalidAmount();
        }

        _startBridge(gnosisBridgeData);

        emit LiFiTransferStarted(
            lifiData.transactionId,
            "gnosis",
            "",
            lifiData.integrator,
            lifiData.referrer,
            swapData[0].sendingAssetId,
            lifiData.receivingAssetId,
            gnosisBridgeData.receiver,
            swapData[0].fromAmount,
            lifiData.destinationChainId,
            true,
            false
        );
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via XDaiBridge
    /// @param gnosisBridgeData data specific to bridge
    function _startBridge(GnosisBridgeData memory gnosisBridgeData) private {
        LibAsset.maxApproveERC20(IERC20(DAI), gnosisBridgeData.xDaiBridge, gnosisBridgeData.amount);
        IXDaiBridge(gnosisBridgeData.xDaiBridge).relayTokens(gnosisBridgeData.receiver, gnosisBridgeData.amount);
    }
}
