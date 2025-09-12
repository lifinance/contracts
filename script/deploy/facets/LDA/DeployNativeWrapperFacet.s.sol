// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { NativeWrapperFacet } from "lifi/Periphery/LDA/Facets/NativeWrapperFacet.sol";
import { DeployScriptBase } from "../utils/DeployScriptBase.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("NativeWrapperFacet") {}

    function run() public returns (NativeWrapperFacet deployed) {
        deployed = NativeWrapperFacet(
            deploy(type(NativeWrapperFacet).creationCode)
        );
    }
}
