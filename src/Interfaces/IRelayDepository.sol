// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IRelayDepository
/// @notice Interface for Relay Depository contracts that handle deposits and withdrawals
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IRelayDepository {
    /// @notice Deposit native tokens to the depository
    /// @param depositor The address of the depositor
    /// @param id The unique identifier for this deposit
    function depositNative(address depositor, bytes32 id) external payable;

    /// @notice Deposit ERC20 tokens to the depository with specified amount
    /// @param depositor The address of the depositor
    /// @param token The address of the ERC20 token
    /// @param amount The amount of tokens to deposit
    /// @param id The unique identifier for this deposit
    function depositErc20(
        address depositor,
        address token,
        uint256 amount,
        bytes32 id
    ) external;

    /// @notice Deposit ERC20 tokens to the depository using allowance
    /// @param depositor The address of the depositor
    /// @param token The address of the ERC20 token
    /// @param id The unique identifier for this deposit
    function depositErc20(
        address depositor,
        address token,
        bytes32 id
    ) external;

    /// @notice Get the allocator address
    /// @return The address of the current allocator
    function getAllocator() external view returns (address);
}
