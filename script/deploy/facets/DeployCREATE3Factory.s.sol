// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";

import { CREATE3Factory } from "lifi/Helpers/CREATE3Factory.sol";

contract DeployScript is Script {
    function run() public returns (CREATE3Factory factory) {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));

        vm.startBroadcast(deployerPrivateKey);

        factory = new CREATE3Factory();

        vm.stopBroadcast();
    }
}
