// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";

/// @title XChainExec Facet
/// @author LI.FI (https://li.fi)
/// @notice Facet used to execute arbitrary swaps/transactions after a successful bridge
contract XChainExecFacet is SwapperV2, ReentrancyGuard {
    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param transferredAssetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    function swapAndCompleteBridgeTokens(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address transferredAssetId,
        address payable receiver
    ) external payable nonReentrant {
        uint256 startingBalance;
        uint256 finalAssetStartingBalance;
        address finalAssetId = _swapData[_swapData.length - 1].receivingAssetId;

        if (!LibAsset.isNativeAsset(finalAssetId)) {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId);
        } else {
            finalAssetStartingBalance = LibAsset.getOwnBalance(finalAssetId) - msg.value;
        }

        if (!LibAsset.isNativeAsset(transferredAssetId)) {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId);
            uint256 allowance = IERC20(transferredAssetId).allowance(msg.sender, address(this));
            LibAsset.depositAsset(transferredAssetId, allowance);
        } else {
            startingBalance = LibAsset.getOwnBalance(transferredAssetId) - msg.value;
        }

        _executeSwaps(_lifiData, _swapData, receiver);

        uint256 postSwapBalance = LibAsset.getOwnBalance(transferredAssetId);
        if (postSwapBalance > startingBalance) {
            LibAsset.transferAsset(transferredAssetId, receiver, postSwapBalance - startingBalance);
        }

        uint256 finalAssetPostSwapBalance = LibAsset.getOwnBalance(finalAssetId);
        if (finalAssetPostSwapBalance > finalAssetStartingBalance) {
            LibAsset.transferAsset(finalAssetId, receiver, finalAssetPostSwapBalance - finalAssetStartingBalance);
        }
    }
}
