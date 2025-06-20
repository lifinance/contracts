// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for iZiSwap pool
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IiZiSwapPool {
    function tokenX() external view returns (address);

    /// @notice Swap tokenY for tokenX, given max amount of tokenY user willing to pay.
    /// @param recipient the address to receive tokenX
    /// @param amount the max amount of tokenY user willing to pay
    /// @param highPt the highest point(price) of x/y during swap
    /// @param data any data to be passed through to the callback
    /// @return amountX amount of tokenX paid
    /// @return amountY amount of tokenY acquired
    function swapY2X(
        address recipient,
        uint128 amount,
        int24 highPt,
        bytes calldata data
    ) external returns (uint256 amountX, uint256 amountY);

    /// @notice Swap tokenX for tokenY, given max amount of tokenX user willing to pay.
    /// @param recipient the address to receive tokenY
    /// @param amount the max amount of tokenX user willing to pay
    /// @param lowPt the lowest point(price) of x/y during swap
    /// @param data any data to be passed through to the callback
    /// @return amountX amount of tokenX acquired
    /// @return amountY amount of tokenY paid
    function swapX2Y(
        address recipient,
        uint128 amount,
        int24 lowPt,
        bytes calldata data
    ) external returns (uint256 amountX, uint256 amountY);
}
