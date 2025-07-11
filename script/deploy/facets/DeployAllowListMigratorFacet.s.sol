// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { AllowListMigratorFacet } from "lifi/Facets/AllowListMigratorFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("AllowListMigratorFacet") {}

    function run()
        public
        returns (AllowListMigratorFacet deployed, bytes memory constructorArgs)
    {
        constructorArgs = "";

        deployed = AllowListMigratorFacet(
            deploy(type(AllowListMigratorFacet).creationCode)
        );
    }
}
