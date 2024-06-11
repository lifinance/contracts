// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { LIFuelFacet } from "lifi/Facets/LIFuelFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("LIFuelFacet") {}

    function run()
        public
        returns (LIFuelFacet deployed, bytes memory constructorArgs)
    {
        deployed = LIFuelFacet(deploy(type(LIFuelFacet).creationCode));
    }
}
