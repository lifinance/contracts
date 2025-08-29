// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployLDAScriptBase } from "./utils/DeployLDAScriptBase.sol";
import { NativeWrapperFacet } from "lifi/Periphery/LDA/Facets/NativeWrapperFacet.sol";

contract DeployScript is DeployLDAScriptBase {
    constructor() DeployLDAScriptBase("NativeWrapperFacet") {}

    function run() public returns (NativeWrapperFacet deployed) {
        deployed = NativeWrapperFacet(deploy(type(NativeWrapperFacet).creationCode));
    }
}
