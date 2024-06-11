// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";

contract DeployScript is UpdateScriptBase {
    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("ThorSwapFacet");
    }
}
