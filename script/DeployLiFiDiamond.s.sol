// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";

import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";

contract DeployScript is Script {
    function run() public returns (LiFiDiamond diamond) {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("SALT");
        bytes32 salt = keccak256(abi.encodePacked(saltPrefix, "LiFiDiamond"));

        vm.startBroadcast(deployerPrivateKey);

        CREATE3Factory factory = CREATE3Factory(factoryAddress);

        address deployedAddress = factory.deploy(
            salt,
            bytes.concat(type(LiFiDiamond).creationCode, abi.encode(vm.addr(deployerPrivateKey), address(0)))
        );

        diamond = LiFiDiamond(address);

        vm.stopBroadcast();
    }
}
