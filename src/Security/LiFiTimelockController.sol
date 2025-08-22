// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title LiFiTimelockController
/// @author LI.FI (https://li.fi)
/// @notice Custom version of Openzeppelin TimelockController to add timelock functionality
/// for any diamondCuts on PROD diamonds
/// @custom:version 1.0.1
/// @notice Interface for diamond pause functionality
/// @dev This interface defines the unpauseDiamond function that must be implemented by the diamond contract
interface EmergencyPause {
    /// @notice Unpauses the diamond with specified blacklist
    /// @param _blacklist Array of addresses to exclude from reactivation
    function unpauseDiamond(address[] calldata _blacklist) external;
}

contract LiFiTimelockController is TimelockController {
    /// @notice The address of the diamond contract that this timelock controls
    address public diamond;

    /// @notice Emitted when the diamond address is updated
    /// @param diamond The new diamond address
    event DiamondAddressUpdated(address indexed diamond);

    /// @param _minDelay Initial minimum delay for operations
    /// @param _proposers Accounts to be granted proposer and canceller roles
    /// @param _executors Accounts to be granted executor role
    /// @param _cancellerWallet Address of the wallet that will be granted CANCELLER role
    /// @param _admin The address that will be the admin of the TimelockController (= the LI.FI MultiSig SAFE)
    /// @param _diamond The address of the diamond contract that this timelock controls
    constructor(
        uint256 _minDelay,
        address[] memory _proposers,
        address[] memory _executors,
        address _cancellerWallet,
        address _admin,
        address _diamond
    ) TimelockController(_minDelay, _proposers, _executors, _admin) {
        // validate constructor parameters
        if (
            _minDelay == 0 ||
            _proposers.length == 0 ||
            _executors.length == 0 ||
            _cancellerWallet == address(0) ||
            _admin == address(0) ||
            _diamond == address(0)
        ) revert InvalidConfig();

        diamond = _diamond;

        // grant CANCELLER role to deployer wallet
        _grantRole(CANCELLER_ROLE, _cancellerWallet);

        emit DiamondAddressUpdated(diamond);
    }

    /// @notice Updates the address of the diamond contract
    /// @dev Can only be called by admin role or if the role is open (granted to address(0))
    /// @param _diamond The new diamond address to set
    function setDiamondAddress(
        address _diamond
    ) external onlyRole(TIMELOCK_ADMIN_ROLE) {
        diamond = _diamond;
        emit DiamondAddressUpdated(diamond);
    }

    /// @notice Unpauses the diamond contract by re-adding all facetAddress-to-function-selector mappings to storage
    ///         This function bypasses the minDelay so that we are able to unpause our diamond without any minDelay
    ///         The unpause function can only remove existing facets (blacklist), not add new code,
    ///         therefore we consider this minDelay exception to be safe
    /// @dev Can only be executed by the TimelockController admin (= the LI.FI MultiSig SAFE)
    /// @param _blacklist The address(es) of facet(s) that should not be reactivated
    /// @custom:security This function intentionally bypasses timelock delay for emergency unpausing
    function unpauseDiamond(
        address[] calldata _blacklist
    ) external onlyRole(TIMELOCK_ADMIN_ROLE) {
        // call the diamond directly (bypassing the minDelay)
        EmergencyPause(diamond).unpauseDiamond(_blacklist);
    }
}
