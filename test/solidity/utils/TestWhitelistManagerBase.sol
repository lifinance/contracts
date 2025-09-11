// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";

/// @title TestWhitelistManagerBase
/// @notice Base contract for managing whitelisting functionality in test facets
abstract contract TestWhitelistManagerBase {
    /// @notice Adds a specific contract-selector pair to the allow list.
    /// @param _contractAddress The contract address to add.
    /// @param _selector The function selector to add.
    function addAllowedContractSelector(address _contractAddress, bytes4 _selector) external {
        LibAllowList.addAllowedContractSelector(_contractAddress, _selector);
    }

    /// @notice Removes a specific contract-selector pair from the allow list.
    /// @param _contractAddress The contract address to remove.
    /// @param _selector The function selector to remove.
    function removeAllowedContractSelector(address _contractAddress, bytes4 _selector) external {
        LibAllowList.removeAllowedContractSelector(_contractAddress, _selector);
    }
}
