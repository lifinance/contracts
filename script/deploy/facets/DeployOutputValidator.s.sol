// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { OutputValidator } from "lifi/Periphery/OutputValidator.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("OutputValidator") {}

    function run() public returns (OutputValidator deployed) {
        deployed = OutputValidator(deploy(type(OutputValidator).creationCode));
    }
}
