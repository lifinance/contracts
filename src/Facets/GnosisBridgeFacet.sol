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
contract GnosisBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2 {
    /// Storage ///

    /// @notice The DAI address on the source chain.
    address private constant DAI = 0x6B175474E89094C44Da98b954EedeAC495271d0F;

    /// @notice The chain id of Gnosis.
    uint64 private constant GNOSIS_CHAIN_ID = 100;

    /// @notice The contract address of the xdai bridge on the source chain.
    IXDaiBridge private immutable xDaiBridge;

    /// Types ///

    /// @param amount The amount of the transfer.
    /// @param receiver The address of the receiver.
    struct GnosisBridgeData {
        uint256 amount;
        address receiver;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _xDaiBridge The contract address of the xdai bridge on the source chain.
    constructor(IXDaiBridge _xDaiBridge) {
        xDaiBridge = _xDaiBridge;
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
        _startBridge(lifiData, gnosisBridgeData, false);
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
        _startBridge(lifiData, gnosisBridgeData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via XDaiBridge
    /// @param lifiData data used purely for tracking and analytics
    /// @param gnosisBridgeData data specific to bridge
    /// @param hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        LiFiData calldata lifiData,
        GnosisBridgeData memory gnosisBridgeData,
        bool hasSourceSwaps
    ) private {
        LibAsset.maxApproveERC20(IERC20(DAI), address(xDaiBridge), gnosisBridgeData.amount);
        xDaiBridge.relayTokens(gnosisBridgeData.receiver, gnosisBridgeData.amount);
        emit LiFiTransferStarted(
            lifiData.transactionId,
            "gnosis",
            "",
            lifiData.integrator,
            lifiData.referrer,
            lifiData.sendingAssetId,
            lifiData.receivingAssetId,
            gnosisBridgeData.receiver,
            lifiData.amount,
            GNOSIS_CHAIN_ID,
            hasSourceSwaps,
            false
        );
    }
}
