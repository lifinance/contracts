// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";
import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";

contract DeployScript is UpdateScriptBase {
    function getExcludes() internal view override returns (bytes4[] memory) {
        AcrossFacetV4 acrossV4;
        bytes4[] memory excludes = new bytes4[](2);
        excludes[0] = acrossV4.SPOKEPOOL.selector;
        excludes[1] = acrossV4.WRAPPED_NATIVE.selector;

        return excludes;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AcrossFacetV4");
    }
}
