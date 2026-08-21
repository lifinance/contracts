// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { FraxFacet } from "lifi/Facets/FraxFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("FraxFacet");
    }

    // initFrax is executed once as the diamondCut init call (see getCallData); keep it out
    // of the registered selectors so the one-shot seeding is not exposed as a diamond method.
    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = FraxFacet.initFrax.selector;
        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/frax.json");
        json = vm.readFile(path);
        bytes memory rawMappings = json.parseRaw(".mappings");
        FraxFacet.ChainIdConfig[] memory chainIdConfigs = abi.decode(
            rawMappings,
            (FraxFacet.ChainIdConfig[])
        );

        return
            abi.encodeWithSelector(
                FraxFacet.initFrax.selector,
                chainIdConfigs
            );
    }
}
