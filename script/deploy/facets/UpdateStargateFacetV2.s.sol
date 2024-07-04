// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { StargateFacetV2 } from "lifi/Facets/StargateFacetV2.sol";

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
        return update("StargateFacetV2");
    }
}
