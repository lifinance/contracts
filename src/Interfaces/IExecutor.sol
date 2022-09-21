// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { LibSwap } from "../Libraries/LibSwap.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";

/// @title Interface for Executor
/// @author LI.FI (https://li.fi)
interface IExecutor {
    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData array of data needed for swaps
    /// @param transferredAssetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    function swapAndCompleteBridgeTokens(
        ILiFi.LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        address transferredAssetId,
        address payable receiver
    ) external payable;
}
