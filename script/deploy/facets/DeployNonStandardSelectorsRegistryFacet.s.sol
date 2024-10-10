// // SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { NonStandardSelectorsRegistryFacet } from "lifi/Facets/NonStandardSelectorsRegistryFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("NonStandardSelectorsRegistryFacet") {}

    function run()
        public
        returns (NonStandardSelectorsRegistryFacet deployed)
    {
        deployed = NonStandardSelectorsRegistryFacet(
            deploy(type(NonStandardSelectorsRegistryFacet).creationCode)
        );
    }
}
