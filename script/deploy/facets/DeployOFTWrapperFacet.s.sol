// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { stdJson } from "forge-std/Script.sol";
import { OFTWrapperFacet } from "lifi/Facets/OFTWrapperFacet.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("OFTWrapperFacet") {}

    function run() public returns (OFTWrapperFacet deployed) {
        deployed = OFTWrapperFacet(deploy(type(OFTWrapperFacet).creationCode));
    }
}
