// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script, console, console2 } from "forge-std/Script.sol";
import { DSTest } from "ds-test/test.sol";

contract ScriptBase is Script, DSTest {
    uint256 internal deployerPrivateKey;
    address internal deployerAddress;
    string internal root;
    string internal network;
    string internal fileSuffix;

    constructor() {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        deployerAddress = vm.addr(deployerPrivateKey);
        root = vm.projectRoot();
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");
    }
}
