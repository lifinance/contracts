// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("WithdrawFacet") {}

    function run() public returns (WithdrawFacet deployed) {
        deployed = WithdrawFacet(deploy(type(WithdrawFacet).creationCode));
    }
}
