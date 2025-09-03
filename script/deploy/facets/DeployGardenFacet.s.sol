// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { GardenFacet } from "lifi/Facets/GardenFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("GardenFacet") {}

    function run()
        public
        returns (GardenFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = getConstructorArgs();

        deployed = GardenFacet(
            deploy(
                bytes.concat(type(GardenFacet).creationCode, constructorArgs)
            )
        );
    }

    function getConstructorArgs() internal override returns (bytes memory) {
        string memory path = string.concat(root, "/config/garden.json");

        // Read the htlcRegistry address from config
        address htlcRegistry = _getConfigContractAddress(
            path,
            string.concat(".", network, ".htlcRegistry")
        );

        return abi.encode(htlcRegistry);
    }
}
