// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { StandardizedCallFacet } from "lifi/Facets/StandardizedCallFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("StandardizedCallFacetFacet") {}

    function run()
        public
        returns (StandardizedCallFacet deployed, bytes memory constructorArgs)
    {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/standardizedCallFacet.json"
        );
        string memory json = vm.readFile(path);
        address example = json.readAddress(
            string.concat(".", network, ".example")
        );

        constructorArgs = abi.encode(example);

        vm.startBroadcast(deployerPrivateKey);

        if (isDeployed()) {
            return (
                StandardizedCallFacet(payable(predicted)),
                constructorArgs
            );
        }

        deployed = StandardizedCallFacet(
            payable(
                factory.deploy(
                    salt,
                    bytes.concat(
                        type(StandardizedCallFacet).creationCode,
                        constructorArgs
                    )
                )
            )
        );

        vm.stopBroadcast();
    }
}
