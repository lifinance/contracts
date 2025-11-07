// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("WhitelistManagerFacet") {}

    function run() public returns (WhitelistManagerFacet deployed) {
        deployed = WhitelistManagerFacet(
            deploy(type(WhitelistManagerFacet).creationCode)
        );
    }
}
