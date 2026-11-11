// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    error NoAllBridgeMappings();
    error InvalidAllBridgeMapping(uint256 index);

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

    /// @notice Reads every `.mappings[i]` row of an AllBridge config by field name
    /// @dev Not `parseRaw` + `abi.decode`: forge may encode object keys alphabetically,
    ///      which swaps `chainId` and `allBridgeChainId` in the struct
    /// @param _json Contents of config/allbridge.json
    /// @return configs One entry per row, in file order
    function _parseChainIdConfigs(
        string memory _json
    ) internal view returns (AllBridgeFacet.ChainIdConfig[] memory configs) {
        uint256 rowCount;
        while (_json.keyExists(_mappingKey(rowCount, ""))) rowCount++;
        if (rowCount == 0) revert NoAllBridgeMappings();

        configs = new AllBridgeFacet.ChainIdConfig[](rowCount);
        for (uint256 i = 0; i < rowCount; i++) {
            uint256 chainId = _json.readUint(_mappingKey(i, ".chainId"));
            uint256 allBridgeChainId = _json.readUint(
                _mappingKey(i, ".allBridgeChainId")
            );
            if (chainId == 0 || allBridgeChainId == 0)
                revert InvalidAllBridgeMapping(i);

            configs[i] = AllBridgeFacet.ChainIdConfig({
                chainId: chainId,
                allBridgeChainId: allBridgeChainId
            });
        }
    }

    /// @notice Builds the JSON path of a mappings row or one of its fields
    /// @param _index Row index
    /// @param _field Field suffix such as ".chainId", or "" for the row itself
    /// @return The path, e.g. ".mappings[3].chainId"
    function _mappingKey(
        uint256 _index,
        string memory _field
    ) internal pure returns (string memory) {
        return string.concat(".mappings[", vm.toString(_index), "]", _field);
    }
}
