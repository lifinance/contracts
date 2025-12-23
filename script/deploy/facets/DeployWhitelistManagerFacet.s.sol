// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { MigrateWhitelistManager } from "./utils/MigrateWhitelistManager.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("WhitelistManagerFacet") {}

    function run() public returns (WhitelistManagerFacet deployed) {
        // Deploy MigrateWhitelistManager using CREATE3
        _deployMigrateContract();

        // Deploy WhitelistManagerFacet
        deployed = WhitelistManagerFacet(
            deploy(type(WhitelistManagerFacet).creationCode)
        );
    }

    function _deployMigrateContract() internal returns (address) {
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        bytes32 migrateSalt = keccak256(
            abi.encodePacked("MigrateWhitelistManager")
        );
        CREATE3Factory create3Factory = CREATE3Factory(factoryAddress);
        address predictedMigrate = create3Factory.getDeployed(
            deployerAddress,
            migrateSalt
        );

        vm.startBroadcast(deployerPrivateKey);

        if (LibAsset.isContract(predictedMigrate)) {
            vm.stopBroadcast();
            return predictedMigrate;
        }

        address deployed = create3Factory.deploy(
            migrateSalt,
            type(MigrateWhitelistManager).creationCode
        );

        vm.stopBroadcast();

        return deployed;
    }
}
