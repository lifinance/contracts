// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { UniV2StyleFacet } from "lifi/Periphery/LDA/Facets/UniV2StyleFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("UniV2StyleFacet") {}

    function run() public returns (UniV2StyleFacet deployed) {
        deployed = UniV2StyleFacet(deploy(type(UniV2StyleFacet).creationCode));
    }
}
