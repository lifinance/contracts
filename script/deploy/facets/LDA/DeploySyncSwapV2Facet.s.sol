// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { SyncSwapV2Facet } from "lifi/Periphery/LDA/Facets/SyncSwapV2Facet.sol";
import { DeployScriptBase } from "../utils/DeployScriptBase.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("SyncSwapV2Facet") {}

    function run() public returns (SyncSwapV2Facet deployed) {
        deployed = SyncSwapV2Facet(deploy(type(SyncSwapV2Facet).creationCode));
    }
}
