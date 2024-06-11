// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IExecutor } from "src/Interfaces/IExecutor.sol";

interface IReceiver {
    function executor() external view returns (IExecutor);
}

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (bool) {
        address executor = json.readAddress(".Executor");
        address receiver = json.readAddress(".Receiver");

        return executor == address(IReceiver(receiver).executor());
    }
}
