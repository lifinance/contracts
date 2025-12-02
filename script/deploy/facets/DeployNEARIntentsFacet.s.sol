// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { NEARIntentsFacet } from "lifi/Facets/NEARIntentsFacet.sol";

/// @title DeployNEARIntentsFacet
/// @author LI.FI (https://li.fi)
/// @notice Deployment script for NEARIntentsFacet
/// @custom:version 1.0.0
contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("NEARIntentsFacet") {}

    function run()
        public
        returns (NEARIntentsFacet deployed, bytes memory constructorArgs)
    {
        deployed = NEARIntentsFacet(
            deploy(type(NEARIntentsFacet).creationCode)
        );
        constructorArgs = "";
    }
}
