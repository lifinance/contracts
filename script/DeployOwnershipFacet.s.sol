// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";

contract DeployScript is Script {
    function run() public returns (OwnershipFacet deployed) {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("SALT");
        string memory network = vm.envString("NETWORK");
        bytes32 salt = keccak256(abi.encodePacked(saltPrefix, "OwnershipFacet"));

        vm.startBroadcast(deployerPrivateKey);

        CREATE3Factory factory = CREATE3Factory(factoryAddress);

        deployed = OwnershipFacet(factory.deploy(salt, type(OwnershipFacet).creationCode));

        vm.stopBroadcast();
    }
}
