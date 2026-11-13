// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { CCTPFacet } from "lifi/Facets/CCTPFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("CCTPFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = CCTPFacet.initCCTP.selector;
        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/cctp.json");
        json = vm.readFile(path);
        bytes memory rawMappings = json.parseRaw(".mappings");
        CCTPFacet.ChainIdConfig[] memory chainIdConfigs =
            abi.decode(rawMappings, (CCTPFacet.ChainIdConfig[]));

        return
            abi.encodeWithSelector(CCTPFacet.initCCTP.selector, chainIdConfigs);
    }
}
