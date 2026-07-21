// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("SupersetFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = SupersetFacet.initSuperset.selector;
        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/superset.json");
        json = vm.readFile(path);
        bytes memory rawMappings = json.parseRaw(".mappings");
        SupersetFacet.ChainIdConfig[] memory chainIdConfigs = abi.decode(
            rawMappings,
            (SupersetFacet.ChainIdConfig[])
        );

        return
            abi.encodeWithSelector(
                SupersetFacet.initSuperset.selector,
                chainIdConfigs
            );
    }
}
