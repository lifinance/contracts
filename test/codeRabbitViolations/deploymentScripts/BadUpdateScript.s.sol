// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "script/deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

/**
 * Violation: Update script that does NOT override getExcludes() even though
 * it should exclude certain selectors from the diamond cut.
 * 
 * Convention violation: Update scripts MUST override getExcludes() for selectors
 * that shouldn't be in the diamond cut.
 * 
 * Example scenario: This facet has deprecated selectors that should be excluded
 * from updates, but the script doesn't override getExcludes() to exclude them.
 */
contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("SomeFacet");
    }

    // Violation: Missing getExcludes() override
    // Should be:
    // function getExcludes() internal pure override returns (bytes4[] memory) {
    //     bytes4[] memory excludes = new bytes4[](2);
    //     excludes[0] = SomeFacet.deprecatedFunction1.selector;
    //     excludes[1] = SomeFacet.deprecatedFunction2.selector;
    //     return excludes;
    // }
    
    // This script will include ALL selectors from SomeFacet, including deprecated ones
    // that should be excluded from the diamond cut.
}
