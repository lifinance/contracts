// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { SynapseBridgeFacet } from "lifi/Facets/SynapseBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("SynapseBridgeFacet") {}

    function run()
        public
        returns (SynapseBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/synapse.json"
        );
        string memory json = vm.readFile(path);
        address synapseBridge = json.readAddress(
            string.concat(".", network, ".router")
        );

        constructorArgs = abi.encode(synapseBridge);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (SynapseBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = SynapseBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(SynapseBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
