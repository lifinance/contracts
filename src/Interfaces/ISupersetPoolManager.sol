// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IOmniTokenAddressBook } from "./IOmniTokenAddressBook.sol";

/// @title ISupersetPoolManager
/// @author LI.FI (https://li.fi)
/// @notice Shared view surface exposed by both Superset pool managers used by SupersetFacet
/// @dev Both `HubPoolManager` and `SpokePoolManager` expose `getOmniTokenAddressBook()`
///      (virtual-pools `src/base/BasePoolManager.sol`), so the facet can resolve the
///      path's input OmniToken without branching on `IS_HUB`.
/// @custom:version 1.0.0
interface ISupersetPoolManager {
    /// @notice Returns the OmniToken address book used to resolve path OmniToken IDs to local tokens
    /// @return The OmniToken address book on the current chain
    function getOmniTokenAddressBook()
        external
        view
        returns (IOmniTokenAddressBook);
}
