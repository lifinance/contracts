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
        return update("HopFacetPacked");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](5);
        excludes[0] = 0x23452b9c;
        excludes[1] = 0x7200b829;
        excludes[2] = 0x8da5cb5b;
        excludes[3] = 0xe30c3978;
        excludes[4] = 0xf2fde38b;

        return excludes;
    }
}
