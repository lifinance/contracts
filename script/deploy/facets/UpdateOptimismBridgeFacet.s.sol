// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { OptimismBridgeFacet } from "lifi/Facets/OptimismBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    struct Config {
        address assetId;
        address bridge;
    }

    /// @dev Config's fields in declared order, under a name no struct declares:
    ///      `forge test` would take the field order from a struct of the same name
    string internal constant TOKEN_ROW_TYPE =
        "OptimismBridgeTokenRow(address assetId,address bridge)";

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("OptimismBridgeFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = OptimismBridgeFacet.initOptimism.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/optimism.json");
        json = vm.readFile(path);

        address standardBridge = _getConfigContractAddress(
            path, string.concat(".", network, ".standardBridge")
        );

        Config[] memory configs = abi.decode(
            vm.parseJsonTypeArray(
                json, string.concat(".", network, ".tokens"), TOKEN_ROW_TYPE
            ),
            (Config[])
        );

        bytes memory callData = abi.encodeWithSelector(
            OptimismBridgeFacet.initOptimism.selector, configs, standardBridge
        );

        return callData;
    }
}
