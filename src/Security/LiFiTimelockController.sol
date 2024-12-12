// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";
import { UnAuthorized } from "../Errors/GenericErrors.sol";

/// @title LiFiTimelockController
/// @author LI.FI (https://li.fi)
/// @notice Custom version of Openzeppelin TimelockController to add timelock functionality for any diamondCuts on PROD diamonds
/// @custom:version 1.0.0
interface EmergencyPause {
    function unpauseDiamond(address[] calldata _blacklist) external;
}

contract LiFiTimelockController is TimelockController {
    modifier onlyTimelockAdmin(address _caller) {
        if (!hasRole(TIMELOCK_ADMIN_ROLE, msg.sender)) revert UnAuthorized();
        _;
    }

    /// @param _minDelay Initial minimum delay for operations
    /// @param _proposers Accounts to be granted proposer and canceller roles
    /// @param _executors Accounts to be granted executor role
    /// @param _admin The address that will be the admin of the TimelockController (= the LI.FI MultiSig SAFE)
    constructor(
        uint256 _minDelay,
        address[] memory _proposers,
        address[] memory _executors,
        address _admin
    ) TimelockController(_minDelay, _proposers, _executors, _admin) {}

    /// @notice Unpauses the diamond contract by re-adding all facetAddress-to-function-selector mappings to storage
    ///         This function bypasses the minDelay so that we are able to unpause our diamond without any minDelay
    ///         The unpause function can only remove existing facets (blacklist), not add new code, therefore we consider this minDelay exception to be safe
    /// @dev can only be executed by the TimelockController admin (= the LI.FI MultiSig SAFE)
    /// @param _blacklist The address(es) of facet(s) that should not be reactivated
    function unpauseDiamond(
        address _diamond,
        address[] calldata _blacklist
    ) external onlyTimelockAdmin(msg.sender) {
        // call the diamond directly (bypassing the minDelay)
        EmergencyPause(_diamond).unpauseDiamond(_blacklist);
    }
}
