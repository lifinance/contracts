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
        constructorArgs = getConstructorArgs();

        deployed = SynapseBridgeFacet(
            deploy(type(SynapseBridgeFacet).creationCode)
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/synapse.json");
        string memory json = vm.readFile(path);

        address synapseRouter = json.readAddress(
            string.concat(".", network, ".router")
        );

        return abi.encode(synapseRouter);
    }
}
