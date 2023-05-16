// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CelerIMFacet } from "lifi/Facets/CelerIMFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CelerIMFacet") {}

    function run()
        public
        returns (CelerIMFacet deployed, bytes memory constructorArgs)
    {
        // get messageBus address
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/cbridge.json"
        );
        string memory json = vm.readFile(path);
        address messageBus = json.readAddress(
            string.concat(".", network, ".messageBus")
        );

        address cfUSDC;
        if (keccak256(abi.encodePacked(network)) == keccak256(abi.encodePacked("mainnet"))) {
            cfUSDC = json.readAddress(
                string.concat(".", network, ".cfUSDC")
            );
        }
        if (messageBus == address(32))
            revert(
                string.concat(
                    "MessageBus address not found in deployment file for network ",
                    network
                )
            );
        // get relayer address
        path = string.concat(
            vm.projectRoot(),
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        json = vm.readFile(path);
        address relayer = json.readAddress(".RelayerCelerIM");
        if (relayer == address(32)) {
            revert(
                string.concat(
                    "Relayer address not found in deployment file for network ",
                    network
                )
            );
        }

        constructorArgs = abi.encode(messageBus, relayer, cfUSDC);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CelerIMFacet(payable(predicted)), constructorArgs);
        }

        deployed = CelerIMFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(CelerIMFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
