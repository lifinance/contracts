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
        constructorArgs = getConstructorArgs();

        deployed = OmniBridgeFacet(deploy(type(OmniBridgeFacet).creationCode));
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/omni.json");

        address foreignOmniBridge = _getConfigContractAddress(
            path,
            string.concat(".", network, ".foreignOmniBridge"),
            false
        );
        address wethOmniBridge = _getConfigContractAddress(
            path,
            string.concat(".", network, ".wethOmniBridge"),
            false
        );

        return abi.encode(foreignOmniBridge, wethOmniBridge);
    }
}
