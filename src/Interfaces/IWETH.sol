// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title IWETH
/// @author LI.FI (https://li.fi)
/// @notice Interface for WETH token
/// @custom:version 1.0.0
interface IWETH {
    /// @notice Deposit native ETH into the WETH contract
    /// @dev This function is used to deposit native ETH into the WETH contract
    function deposit() external payable;

    /// @notice Withdraw WETH to native ETH
    /// @dev This function is used to withdraw WETH to native ETH
    function withdraw(uint256) external;

    /// @notice Get the balance of an address
    /// @dev This function is used to get the balance of an address
    /// @return The balance of the address
    function balanceOf(address) external view returns (uint256);
}
