// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { DeployScriptBase } from "./utils/DeployScriptBase.sol";
import { Patcher } from "lifi/Periphery/Patcher.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("Patcher") {}

    function run() public returns (Patcher deployed, bytes memory constructorArgs) {
        constructorArgs = getConstructorArgs();
        deployed = Patcher(deploy(type(Patcher).creationCode));
    }


    function getConstructorArgs()
        internal
        pure
        override
        returns (bytes memory)
    {
        return
            abi.encode(
                //0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE
                0xD3b2b0aC0AFdd0d166a495f5E9fca4eCc715a782
            );
    }
}
