// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAccess } from "../Libraries/LibAccess.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";

/// @title Allow List Migrator Facet
/// @author LI.FI (https://li.fi)
/// @notice Facet for migrating the allow list configuration during diamond upgrades
/// @dev This facet should be added temporarily during upgrades, used for migration, then removed
/// @custom:version 1.0.0
contract AllowListMigratorFacet {
    /// @notice Event emitted when the allow list configuration is migrated
    event AllowListConfigMigrated(address[] contracts, bytes4[] selectors);

    /// @notice Migrate the allow list configuration with new contracts and selectors
    /// @dev This function can only be called by the diamond owner or authorized addresses
    /// @param _contracts Array of contract addresses to allow
    /// @param _selectors Array of selectors to allow
    function migrate(
        address[] calldata _contracts,
        bytes4[] calldata _selectors
    ) external {
        if (msg.sender != LibDiamond.contractOwner()) {
            LibAccess.enforceAccessControl();
        }

        LibAllowList.migrate(_contracts, _selectors);

        emit AllowListConfigMigrated(_contracts, _selectors);
    }

    function isMigrated() external view returns (bool) {
        return LibAllowList.isMigrated();
    }
}
