// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";

contract DeployScriptBase is Script {
    uint256 internal deployerPrivateKey;
    address internal deployerAddress;
    address internal predicted;
    CREATE3Factory internal factory;
    bytes32 internal salt;
    string internal root;
    string internal network;
    string internal fileSuffix;

    constructor(string memory contractName) {
        deployerPrivateKey = uint256(vm.envBytes32("PRIVATE_KEY"));
        deployerAddress = vm.addr(deployerPrivateKey);
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("DEPLOYSALT");
        root = vm.projectRoot();
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");
        salt = keccak256(abi.encodePacked(saltPrefix, contractName));
        factory = CREATE3Factory(factoryAddress);
        predicted = factory.getDeployed(deployerAddress, salt);
    }

    function isContract(address _contractAddr) internal view returns (bool) {
        uint256 size;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            size := extcodesize(_contractAddr)
        }
        return size > 0;
    }

    function isDeployed() internal view returns (bool) {
        return isContract(predicted);
    }
}
