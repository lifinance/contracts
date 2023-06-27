// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { OmniBridgeFacet } from "lifi/Facets/OmniBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("OmniBridgeFacet") {}

    function run()
        public
        returns (OmniBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/omni.json"
        );
        string memory json = vm.readFile(path);
        address foreignOmniBridge = json.readAddress(
            string.concat(".", network, ".foreignOmniBridge")
        );
        address wethOmniBridge = json.readAddress(
            string.concat(".", network, ".wethOmniBridge")
        );

        constructorArgs = abi.encode(foreignOmniBridge, wethOmniBridge);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (OmniBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = OmniBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(OmniBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
