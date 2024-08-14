// SPDX-License-Identifier: MIT
/// @custom:version 1.0.0
pragma solidity 0.8.17;

interface IMultichainToken {
    function underlying() external returns (address);
}
