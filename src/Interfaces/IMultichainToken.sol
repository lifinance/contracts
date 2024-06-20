// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

interface IMultichainToken {
    function underlying() external returns (address);
}
