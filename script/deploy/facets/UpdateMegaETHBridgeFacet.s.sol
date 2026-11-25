// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { MegaETHBridgeFacet } from "lifi/Facets/MegaETHBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    struct Config {
        address assetId;
        address bridge;
    }

    /// @dev Config's fields in declared order, under a name no struct declares:
    ///      `forge test` would take the field order from a struct of the same name
    string internal constant TOKEN_ROW_TYPE =
        "MegaETHBridgeTokenRow(address assetId,address bridge)";

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("MegaETHBridgeFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = MegaETHBridgeFacet.initMegaETH.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/megaethBridge.json");
        json = vm.readFile(path);

        address defaultBridge = _getConfigContractAddress(
            path, string.concat(".", network, ".defaultBridge")
        );

        Config[] memory configs = abi.decode(
            vm.parseJsonTypeArray(
                json, string.concat(".", network, ".tokens"), TOKEN_ROW_TYPE
            ),
            (Config[])
        );

        bytes memory callData = abi.encodeWithSelector(
            MegaETHBridgeFacet.initMegaETH.selector, configs, defaultBridge
        );

        return callData;
    }
}
