// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { MegaETHBridgeFacet } from "lifi/Facets/MegaETHBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        address assetId;
        address bridge;
    }

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
        path = string.concat(root, "/config/megaeth.json");
        json = vm.readFile(path);

        address standardBridge = _getConfigContractAddress(
            path,
            string.concat(".", network, ".standardBridge")
        );

        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        bytes memory callData = abi.encodeWithSelector(
            MegaETHBridgeFacet.initMegaETH.selector,
            configs,
            standardBridge
        );

        return callData;
    }
}
