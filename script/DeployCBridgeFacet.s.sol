// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CBridgeFacet } from "lifi/Facets/CBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CBridgeFacet") {}

    function run()
        public
        returns (CBridgeFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/cbridge.json"
        );
        string memory json = vm.readFile(path);
        address cBridge = json.readAddress(
            string.concat(".", network, ".cBridge")
        );

        constructorArgs = abi.encode(cBridge);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (CBridgeFacet(payable(predicted)), constructorArgs);
        }

        deployed = CBridgeFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(CBridgeFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
