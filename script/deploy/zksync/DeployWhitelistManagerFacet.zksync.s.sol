// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase, IContractDeployer } from "./utils/DeployScriptBase.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { MigrateWhitelistManager } from "../facets/utils/MigrateWhitelistManager.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("WhitelistManagerFacet") {}

    function run() public returns (WhitelistManagerFacet deployed) {
        // Deploy MigrateWhitelistManager using CREATE2
        _deployMigrateContract();

        // Deploy WhitelistManagerFacet
        deployed = WhitelistManagerFacet(
            deploy(type(WhitelistManagerFacet).creationCode)
        );
    }

    function _deployMigrateContract() internal returns (address) {
        bytes32 migrateSalt = keccak256(
            abi.encodePacked("MigrateWhitelistManager")
        );

        // Get bytecode hash for zkSync CREATE2 prediction
        string memory path = string.concat(
            root,
            "/zkout/",
            "MigrateWhitelistManager",
            ".sol/",
            "MigrateWhitelistManager",
            ".json"
        );
        string memory json = vm.readFile(path);
        bytes32 bytecodeHash = json.readBytes32(".hash");

        address predictedMigrate = IContractDeployer(DEPLOYER_CONTRACT_ADDRESS)
            .getNewAddressCreate2(
                deployerAddress,
                bytecodeHash,
                migrateSalt,
                ""
            );

        vm.startBroadcast(deployerPrivateKey);

        if (LibAsset.isContract(predictedMigrate)) {
            vm.stopBroadcast();
            return predictedMigrate;
        }

        MigrateWhitelistManager deployed = new MigrateWhitelistManager{
            salt: migrateSalt
        }();

        vm.stopBroadcast();

        return address(deployed);
    }
}
