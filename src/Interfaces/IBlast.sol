// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IBlast
/// @notice Interface for Blast network's gas fee management precompile
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IBlast {
    /// @notice Configures the contract to use claimable gas mode
    /// @dev This allows the contract to accumulate gas fees that can be claimed later
    function configureClaimableGas() external;

    /// @notice Claims all accumulated gas fees for a contract
    /// @param _contractAddress The address of the contract to claim gas fees for
    /// @param _recipient The address that will receive the claimed gas fees
    /// @return The amount of gas fees claimed
    /// @dev The claim rate starts at 50% and increases to 100% over time
    function claimAllGas(
        address _contractAddress,
        address _recipient
    ) external returns (uint256);
}
