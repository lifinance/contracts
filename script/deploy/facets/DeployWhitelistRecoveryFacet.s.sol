// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { WhitelistRecoveryFacet } from "lifi/Facets/WhitelistRecoveryFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("WhitelistRecoveryFacet") {}

    function run() public returns (WhitelistRecoveryFacet deployed) {
        // Deploy WhitelistRecoveryFacet
        deployed = WhitelistRecoveryFacet(
            deploy(type(WhitelistRecoveryFacet).creationCode)
        );
    }
}
