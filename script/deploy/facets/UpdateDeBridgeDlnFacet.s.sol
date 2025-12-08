// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DeBridgeDlnFacet } from "lifi/Facets/DeBridgeDlnFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct ChainIdConfig {
        uint256 chainId;
        uint256 deBridgeChainId;
    }

    function run()
        public
        returns (address[] memory facets, bytes memory cutData)
    {
        return update("DeBridgeDlnFacet");
    }

    function getCallData() internal override returns (bytes memory) {
        path = string.concat(root, "/config/debridgedln.json");
        json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(".mappings");
        ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (ChainIdConfig[])
        );

        bytes memory callData = abi.encodeWithSelector(
            DeBridgeDlnFacet.initDeBridgeDln.selector,
            cidCfg
        );

        return callData;
    }
}
