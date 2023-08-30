// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { WormholeFacet } from "lifi/Facets/WormholeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        uint256 chainId;
        uint16 wormholeChainId;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("WormholeFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = WormholeFacet.initWormhole.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/wormhole.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(".chains");
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        bytes memory callData = abi.encodeWithSelector(
            WormholeFacet.initWormhole.selector,
            configs
        );

        return callData;
    }
}
