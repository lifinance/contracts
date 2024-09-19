// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { AcrossFacetV3 } from "lifi/Facets/AcrossFacetV3.sol";
import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";

contract DeployScript is UpdateScriptBase {
    function getExcludes() internal view override returns (bytes4[] memory) {
        AcrossFacetV3 acrossV3;
        bytes4[] memory excludes = new bytes4[](2);
        excludes[0] = acrossV3.spokePool.selector;
        excludes[1] = acrossV3.wrappedNative.selector;

        return excludes;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AcrossFacetV3");
    }
}
