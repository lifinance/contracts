// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { MigrateWhitelistManager } from "../facets/utils/MigrateWhitelistManager.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("WhitelistManagerFacet") {}

    function run() public returns (WhitelistManagerFacet deployed) {
        // Deploy MigrateWhitelistManager using CREATE2
        _deployMigrateContract();

        // Deploy WhitelistManagerFacet
        deployed = WhitelistManagerFacet(
            deploy(type(WhitelistManagerFacet).creationCode)
        );
    }

    function _deployMigrateContract() internal returns (address deployed) {
        bytes32 migrateSalt = keccak256(
            abi.encodePacked("MigrateWhitelistManager")
        );

        // Get bytecode hash and predict CREATE2 address
        bytes32 bytecodeHash = getZkSyncBytecodeHash(
            "MigrateWhitelistManager"
        );
        address predictedMigrate = predictCreate2Address(
            bytecodeHash,
            migrateSalt,
            ""
        );

        if (LibAsset.isContract(predictedMigrate)) {
            return predictedMigrate;
        }

        vm.startBroadcast(deployerPrivateKey);

        // Deploy using CREATE2 - foundry-zksync routes through ZKSYNC_CREATE2_FACTORY
        MigrateWhitelistManager migrateContract = new MigrateWhitelistManager{
            salt: migrateSalt
        }();
        deployed = address(migrateContract);

        vm.stopBroadcast();
    }
}
