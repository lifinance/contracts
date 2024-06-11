// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.0;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        address ammWrapper;
        address bridge;
        string name;
        address token;
    }

    struct Bridge {
        address assetId;
        address bridge;
    }

    Bridge[] internal bridges;

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("HopFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = HopFacet.initHop.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        for (uint256 i = 0; i < configs.length; i++) {
            Bridge memory b;
            Config memory c = configs[i];
            b.assetId = c.token;
            b.bridge = c.ammWrapper == address(0) ? c.bridge : c.ammWrapper;
            bridges.push(b);
        }

        bytes memory callData = abi.encodeWithSelector(
            HopFacet.initHop.selector,
            bridges
        );

        return callData;
    }
}
