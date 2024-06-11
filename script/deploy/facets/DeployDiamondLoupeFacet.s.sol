// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("DiamondLoupeFacet") {}

    function run() public returns (DiamondLoupeFacet deployed) {
        deployed = DiamondLoupeFacet(
            deploy(type(DiamondLoupeFacet).creationCode)
        );
    }
}
