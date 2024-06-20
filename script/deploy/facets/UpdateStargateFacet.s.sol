// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct ChainIdConfig {
        uint256 chainId;
        uint16 layerZeroChainId;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("StargateFacet");
    }

    function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](1);
        excludes[0] = StargateFacet.initStargate.selector;

        return excludes;
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/stargate.json");
        json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(".chains");
        ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (ChainIdConfig[])
        );

        bytes memory callData = abi.encodeWithSelector(
            StargateFacet.initStargate.selector,
            cidCfg
        );

        return callData;
    }
}
