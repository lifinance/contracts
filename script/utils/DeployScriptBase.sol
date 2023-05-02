// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { Script } from "forge-std/Script.sol";
import { console } from "forge-std/console.sol";

import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { DSTest } from "ds-test/test.sol";

contract DeployScriptBase is Script, DSTest {
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
        bool deployToDefaultDiamondAddress = vm.envBool(
            "DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS"
        );
        root = vm.projectRoot();
        network = vm.envString("NETWORK");
        fileSuffix = vm.envString("FILE_SUFFIX");

        // if LiFiDiamond should be deployed to 0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
        // then set this value in deployConfig.sh:
        // DEPLOY_TO_DEFAULT_DIAMOND_ADDRESS=true
        if (
            keccak256(abi.encodePacked(contractName)) ==
            keccak256(abi.encodePacked("LiFiDiamond")) &&
            deployToDefaultDiamondAddress
        ) salt = vm.envBytes32("DEFAULT_DIAMOND_ADDRESS_DEPLOYSALT");
        else salt = keccak256(abi.encodePacked(saltPrefix, contractName));
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
