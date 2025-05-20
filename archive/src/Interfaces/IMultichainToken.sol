// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

/// @title Interface for Multichain Token
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0
interface IMultichainToken {
    function underlying() external returns (address);
}
