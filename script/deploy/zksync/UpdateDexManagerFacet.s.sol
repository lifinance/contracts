// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { DexManagerFacet } from "lifi/Facets/DexManagerFacet.sol";

contract DeployScript is UpdateScriptBase {
    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("DexManagerFacet");
    }
}
