// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AllBridgeFacet") {}

    function run()
        public
        returns (AllBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/allbridge.json"
        );
        string memory json = vm.readFile(path);
        address allBridge = json.readAddress(
            string.concat(".", network, ".allBridge")
        );

        constructorArgs = abi.encode(allBridge);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (AllBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = AllBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(AllBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
