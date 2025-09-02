// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { SyncSwapV2Facet } from "lifi/Periphery/LDA/Facets/SyncSwapV2Facet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("SyncSwapV2Facet") {}

    function run() public returns (SyncSwapV2Facet deployed) {
        deployed = SyncSwapV2Facet(deploy(type(SyncSwapV2Facet).creationCode));
    }
}
