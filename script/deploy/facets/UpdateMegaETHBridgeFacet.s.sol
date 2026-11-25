// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { MegaETHBridgeFacet } from "lifi/Facets/MegaETHBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    struct Config {
        address assetId;
        address bridge;
    }

    /// @dev Config's fields in declared order, keyed as config/megaethBridge.json documents a token
    ///      row ({ "address", "bridgeAddress" }), under a name no struct declares: `forge test`
    ///      would take the field order from a struct of the same name
    string internal constant TOKEN_ROW_TYPE =
        "MegaETHBridgeTokenRow(address address,address bridgeAddress)";

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

        Config[] memory configs = _readTokens(json);

        bytes memory callData = abi.encodeWithSelector(
            MegaETHBridgeFacet.initMegaETH.selector, configs, defaultBridge
        );

        return callData;
    }

    function _readTokens(string memory _json)
        internal
        view
        returns (Config[] memory)
    {
        return abi.decode(
            vm.parseJsonTypeArray(
                _json, string.concat(".", network, ".tokens"), TOKEN_ROW_TYPE
            ),
            (Config[])
        );
    }
}
