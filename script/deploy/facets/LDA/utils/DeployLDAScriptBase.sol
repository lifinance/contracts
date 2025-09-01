// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ScriptBase } from "../../utils/ScriptBase.sol";
import { CREATE3Factory } from "create3-factory/CREATE3Factory.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

contract DeployLDAScriptBase is ScriptBase {
    address internal predicted;
    CREATE3Factory internal factory;
    bytes32 internal salt;

    constructor(string memory contractName) {
        address factoryAddress = vm.envAddress("CREATE3_FACTORY_ADDRESS");
        string memory saltPrefix = vm.envString("DEPLOYSALT");
        bool deployToDefaultLDADiamondAddress = vm.envOr(
            "DEPLOY_TO_DEFAULT_LDA_DIAMOND_ADDRESS",
            false
        );

        // Special handling for LDADiamond if default address deployment is enabled
        // This allows for deterministic LDA diamond addresses similar to LiFi diamond
        if (
            keccak256(abi.encodePacked(contractName)) ==
            keccak256(abi.encodePacked("LDADiamond")) &&
            deployToDefaultLDADiamondAddress
        ) {
            // Use a different salt for LDA diamond to avoid conflicts with LiFi diamond
            salt = vm.envOr(
                "DEFAULT_LDA_DIAMOND_ADDRESS_DEPLOYSALT",
                keccak256(abi.encodePacked(saltPrefix, "LDA", contractName))
            );
        } else {
            // For all other LDA contracts, use standard salt with LDA prefix to avoid conflicts
            salt = keccak256(
                abi.encodePacked(saltPrefix, "LDA", contractName)
            );
        }

        factory = CREATE3Factory(factoryAddress);
        predicted = factory.getDeployed(deployerAddress, salt);
    }

    function getConstructorArgs() internal virtual returns (bytes memory) {}

    function deploy(
        bytes memory creationCode
    ) internal virtual returns (address payable deployed) {
        bytes memory constructorArgs = getConstructorArgs();

        vm.startBroadcast(deployerPrivateKey);
        emit log_named_address("LI.FI LDA: Predicted Address: ", predicted);

        if (LibAsset.isContract(predicted)) {
            emit log("LI.FI LDA: Contract is already deployed");
            return payable(predicted);
        }

        // @DEV: activate on demand when deployment fails (e.g. to try manual deployment)
        // reproduce and log calldata that is sent to CREATE3
        // bytes memory create3Calldata = abi.encodeWithSelector(
        //     CREATE3Factory.deploy.selector,
        //     salt,
        //     bytes.concat(creationCode, constructorArgs)
        // );
        // emit log("LI.FI LDA: Will send this calldata to CREATE3Factory now: ");
        // emit log_bytes(create3Calldata);
        // emit log("        ");

        deployed = payable(
            factory.deploy(salt, bytes.concat(creationCode, constructorArgs))
        );

        vm.stopBroadcast();
    }
}
