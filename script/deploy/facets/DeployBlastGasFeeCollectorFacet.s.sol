// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { BlastGasFeeCollectorFacet } from "lifi/Facets/BlastGasFeeCollectorFacet.sol";
import { stdJson } from "forge-std/Script.sol";

contract DeployScript is DeployScriptBase {
    using stdJson for string;

    constructor() DeployScriptBase("BlastGasFeeCollectorFacet") {}

    function run() public returns (BlastGasFeeCollectorFacet deployed) {
        deployed = BlastGasFeeCollectorFacet(
            deploy(type(BlastGasFeeCollectorFacet).creationCode)
        );
    }
}
