// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("ChainflipFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        // No functions to exclude
        return new bytes4[](0);
    }

    function getCallData() internal pure override returns (bytes memory) {
        // No initialization needed
        return new bytes(0);
    }
}
