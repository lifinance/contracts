// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { LiFiIntentEscrowFacetV2 } from "lifi/Facets/LiFiIntentEscrowFacetV2.sol";
import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";

contract DeployScript is UpdateScriptBase {
    function getExcludes() internal view override returns (bytes4[] memory) {
        // Exclude public constant/immutable getters from the diamond cut.
        // MULTIPLIER_BASE() collides with the AcrossV4 facets' identical
        // constant; without excluding it the cut would treat the shared
        // selector as a facet replacement and strip the other facet.
        LiFiIntentEscrowFacetV2 facet;
        bytes4[] memory excludes = new bytes4[](2);
        excludes[0] = facet.MULTIPLIER_BASE.selector;
        excludes[1] = facet.LIFI_INTENT_ESCROW_SETTLER.selector;

        return excludes;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("LiFiIntentEscrowFacetV2");
    }
}
