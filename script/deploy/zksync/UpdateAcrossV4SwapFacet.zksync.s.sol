// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";

contract DeployScript is UpdateScriptBase {
    function getExcludes() internal view override returns (bytes4[] memory) {
        AcrossV4SwapFacet acrossV4Swap;
        bytes4[] memory excludes = new bytes4[](2);
        excludes[0] = acrossV4Swap.SPOKE_POOL_PERIPHERY.selector;
        excludes[1] = acrossV4Swap.SPOKE_POOL.selector;

        return excludes;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AcrossV4SwapFacet");
    }
}
