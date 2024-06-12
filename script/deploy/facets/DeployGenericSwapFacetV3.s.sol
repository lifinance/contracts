// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("GenericSwapFacetV3") {}

    function run() public returns (GenericSwapFacetV3 deployed) {
        deployed = GenericSwapFacetV3(
            deploy(type(GenericSwapFacetV3).creationCode)
        );
    }
}
