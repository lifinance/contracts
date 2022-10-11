// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import "forge-std/console.sol";

import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";

contract DeployScript is Script {
    using stdJson for string;

    uint256 internal deployerPrivateKey;
    address internal deployerAddress;
    CREATE3Factory internal factory;
    bytes32 internal salt;
    string internal network;

    constructor(string memory contractName) {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        deployerAddress = vm.addr(deployerPrivateKey);
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("SALT");
        network = vm.envString("NETWORK");
        salt = keccak256(abi.encodePacked(saltPrefix, contractName));
        factory = CREATE3Factory(factoryAddress);
    }

    function isContract(address _contractAddr) internal view returns (bool) {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(_contractAddr)
        }
        return size > 0;
    }
}
