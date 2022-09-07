// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

struct LibStorage {
    mapping(address => bool) dexAllowlist;
    mapping(bytes4 => bool) dexFuncSignatureAllowList;
    address[] dexs;
}
