// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("AllBridgeFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = AllBridgeFacet.initAllBridge.selector;
        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/allbridge.json");
        json = vm.readFile(path);
        bytes memory rawMappings = json.parseRaw(".mappings");
        AllBridgeFacet.ChainIdConfig[] memory chainIdConfigs = abi.decode(
            rawMappings,
            (AllBridgeFacet.ChainIdConfig[])
        );

        return
            abi.encodeWithSelector(
                AllBridgeFacet.initAllBridge.selector,
                chainIdConfigs
            );
    }
}
