// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";

/// @title TestWhitelistManagerBase
/// @notice Base contract for managing whitelisting functionality in test facets
abstract contract TestWhitelistManagerBase {
    /// @notice Adds a contract address to the whitelist
    /// @param _contractAddress The address to add to the whitelist
    function addToWhitelist(address _contractAddress) external {
        LibAllowList.addAllowedContract(_contractAddress);
    }

    /// @notice Removes a contract address from the whitelist
    /// @param _contractAddress The address to remove from the whitelist
    function removeFromWhitelist(address _contractAddress) external {
        LibAllowList.removeAllowedContract(_contractAddress);
    }

    /// @notice Adds a function selector to the whitelist
    /// @param _selector The function selector to add to the whitelist
    function setFunctionWhitelistBySelector(bytes4 _selector) external {
        LibAllowList.addAllowedSelector(_selector);
    }

    /// @notice Removes a function selector from the whitelist
    /// @param _selector The function selector to remove from the whitelist
    function removeFunctionApprovalBySelector(bytes4 _selector) external {
        LibAllowList.removeAllowedSelector(_selector);
    }
}
