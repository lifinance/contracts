// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    error NoAllBridgeMappings();

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

        return
            abi.encodeWithSelector(
                AllBridgeFacet.initAllBridge.selector,
                _parseChainIdConfigs(json)
            );
    }

    /// @dev parseRaw + abi.decode fills struct fields in JSON key order, which some forge versions
    ///      sort alphabetically, putting allBridgeChainId into the chainId slot
    function _parseChainIdConfigs(
        string memory _json
    ) internal view returns (AllBridgeFacet.ChainIdConfig[] memory configs) {
        uint256 rowCount;
        while (_json.keyExists(_mappingKey(rowCount, ""))) rowCount++;
        if (rowCount == 0) revert NoAllBridgeMappings();

        configs = new AllBridgeFacet.ChainIdConfig[](rowCount);
        for (uint256 i = 0; i < rowCount; i++) {
            configs[i] = AllBridgeFacet.ChainIdConfig({
                chainId: _json.readUint(_mappingKey(i, ".chainId")),
                allBridgeChainId: _json.readUint(
                    _mappingKey(i, ".allBridgeChainId")
                )
            });
        }
    }

    function _mappingKey(
        uint256 _index,
        string memory _field
    ) internal pure returns (string memory) {
        return string.concat(".mappings[", vm.toString(_index), "]", _field);
    }
}
