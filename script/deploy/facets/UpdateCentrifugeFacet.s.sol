// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { CentrifugeFacet } from "lifi/Facets/CentrifugeFacet.sol";
import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";

contract DeployScript is UpdateScriptBase {
    function getExcludes() internal view override returns (bytes4[] memory) {
        CentrifugeFacet centrifuge;
        bytes4[] memory excludes = new bytes4[](1);
        // the immutable getter stays off the diamond: it is read directly on the facet by the
        // immutable-bindings-match-config health check, and keeping a generically-named
        // selector out of the diamond avoids a future collision (see [CONV:FACET-SELECTORS])
        excludes[0] = centrifuge.TOKEN_BRIDGE.selector;

        return excludes;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("CentrifugeFacet");
    }
}
