// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("CBridgeFacetPacked") {}

    function run()
        public
        returns (CBridgeFacetPacked deployed, bytes memory constructorArgs)
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
            return (CBridgeFacetPacked(payable(predicted)), constructorArgs);
        }

        deployed = CBridgeFacetPacked(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(CBridgeFacetPacked).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
