// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { PolymerCCTPFacet } from "lifi/Facets/PolymerCCTPFacet.sol";

contract DeployScript is UpdateScriptBase {
    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("PolymerCCTPFacet");
    }

    function getExcludes() internal view override returns (bytes4[] memory) {
        PolymerCCTPFacet polymer;
        bytes4[] memory excludes = new bytes4[](2);
        excludes[0] = PolymerCCTPFacet.initPolymerCCTP.selector;
        // Exclude USDC() to prevent conflict with CelerCircleBridgeFacet
        // Both facets have USDC() but they should coexist - Celer's USDC() will remain active
        excludes[1] = polymer.USDC.selector;
        return excludes;
    }

    function getCallData() internal pure override returns (bytes memory) {
        return
            abi.encodeWithSelector(PolymerCCTPFacet.initPolymerCCTP.selector);
    }
}
