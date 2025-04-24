// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

/// @title IOftERC4626 Interface
/// @notice Interface for OFT-enabled ERC4626 vault with share transfer functionality
interface IOftERC4626 {
    /// @notice Returns the current exchange rate between shares and assets
    /// @return The current exchange rate scaled by 1e18
    function exchangeRate() external view returns (uint256);

    /// @notice Transfers shares from the caller to a recipient
    /// @param to The address to transfer shares to
    /// @param shares The amount of shares to transfer
    function transferShares(address to, uint256 shares) external;
}
