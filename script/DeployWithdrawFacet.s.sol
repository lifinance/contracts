// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";

contract DeployScript is Script {
    function run() public returns (WithdrawFacet deployed) {
        uint256 deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("SALT");
        string memory network = vm.envString("NETWORK");
        bytes32 salt = keccak256(abi.encodePacked(saltPrefix, "WithdrawFacet"));

        vm.startBroadcast(deployerPrivateKey);

        CREATE3Factory factory = CREATE3Factory(factoryAddress);

        deployed = WithdrawFacet(factory.deploy(salt, type(WithdrawFacet).creationCode));

        vm.stopBroadcast();
    }
}
