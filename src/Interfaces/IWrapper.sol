// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IWrapper
/// @notice Interface for token wrapper contracts
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IWrapper {
    function deposit() external payable;

    // solhint-disable-next-line explicit-types
    function withdraw(uint wad) external;
}
