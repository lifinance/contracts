// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { Patcher } from "lifi/Periphery/Patcher.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("Patcher") {}

    function run() public returns (Patcher deployed) {
        deployed = Patcher(deploy(type(Patcher).creationCode));
    }
}
