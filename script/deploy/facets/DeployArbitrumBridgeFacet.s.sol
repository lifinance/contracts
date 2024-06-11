// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { ArbitrumBridgeFacet } from "lifi/Facets/ArbitrumBridgeFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("ArbitrumBridgeFacet") {}

    function run()
        public
        returns (ArbitrumBridgeFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = ArbitrumBridgeFacet(
            deploy(type(ArbitrumBridgeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/arbitrum.json");
        string memory json = vm.readFile(path);

        address gatewayRouter = json.readAddress(
            string.concat(".", network, ".gatewayRouter")
        );
        address inbox = json.readAddress(
            string.concat(".", network, ".inbox")
        );

        return abi.encode(gatewayRouter, inbox);
    }
}
