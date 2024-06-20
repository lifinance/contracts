// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.17;

interface IRootChainManager {
    /// @notice Move ether from root to child chain, accepts ether transfer
    /// @dev Keep in mind this ether cannot be used to pay gas on child chain
    ///      Use Matic tokens deposited using plasma mechanism for that
    /// @param user address of account that should receive WETH on child chain
    function depositEtherFor(address user) external payable;

    /// @notice Move tokens from root to child chain
    /// @dev This mechanism supports arbitrary tokens as long as
    ///      its predicate has been registered and the token is mapped
    /// @param user address of account that should receive this deposit on child chain
    /// @param rootToken address of token that is being deposited
    /// @param depositData bytes data that is sent to predicate and
    ///        child token contracts to handle deposit
    function depositFor(
        address user,
        address rootToken,
        bytes calldata depositData
    ) external;

    /// @notice Returns child token address for root token
    /// @param rootToken Root token address
    /// @return childToken Child token address
    function rootToChildToken(
        address rootToken
    ) external view returns (address childToken);
}
