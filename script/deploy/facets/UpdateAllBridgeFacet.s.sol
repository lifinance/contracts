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
        // parseRaw + abi.decode fills struct fields in JSON key order, which some forge versions
        // sort alphabetically, putting allBridgeChainId into the chainId slot
        uint256 rowCount;
        while (json.keyExists(_mappingKey(rowCount, ""))) rowCount++;

        AllBridgeFacet.ChainIdConfig[]
            memory chainIdConfigs = new AllBridgeFacet.ChainIdConfig[](
                rowCount
            );
        for (uint256 i = 0; i < rowCount; i++) {
            chainIdConfigs[i] = AllBridgeFacet.ChainIdConfig({
                chainId: json.readUint(_mappingKey(i, ".chainId")),
                allBridgeChainId: json.readUint(
                    _mappingKey(i, ".allBridgeChainId")
                )
            });
        }

        return
            abi.encodeWithSelector(
                AllBridgeFacet.initAllBridge.selector,
                chainIdConfigs
            );
    }

    function _mappingKey(
        uint256 _index,
        string memory _field
    ) internal pure returns (string memory) {
        return string.concat(".mappings[", vm.toString(_index), "]", _field);
    }
}
