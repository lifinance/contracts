// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for Celer Token
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface ICelerToken {
    function canonical() external returns (address);
}
