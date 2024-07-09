// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { IntentFactory } from "lifi/Periphery/IntentFactory.sol";
import { Intent } from "lifi/Helpers/Intent.sol";

contract DeployScript is DeployScriptBase {
    Intent implementation;

    constructor() DeployScriptBase("IntentFactory") {}

    function run() public returns (IntentFactory deployed) {
        deployed = IntentFactory(deploy(type(IntentFactory).creationCode));
    }
}
