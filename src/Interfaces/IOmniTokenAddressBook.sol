// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title IOmniTokenAddressBook
/// @author LI.FI (https://li.fi)
/// @notice Minimal interface for Superset's OmniToken address book used by SupersetFacet
/// @dev Mirrors `getAddressForOmniToken` from Superset's `IOmniTokenAddressBook`
///      (virtual-pools `src/interfaces/IOmniTokenAddressBook.sol`).
/// @custom:version 1.0.0
interface IOmniTokenAddressBook {
    /// @notice Resolves a global OmniToken ID to its local ERC20 address on the current chain
    /// @param _id Global OmniToken ID
    /// @return Local token address, or address(0) if the ID is not mapped locally
    function getAddressForOmniToken(
        uint256 _id
    ) external view returns (address);
}
