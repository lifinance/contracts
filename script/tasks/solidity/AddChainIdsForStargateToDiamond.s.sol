// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import { UpdateScriptBase } from "../../deploy/facets/utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct PoolIdConfig {
        address token;
        uint16 poolId;
    }

    struct ChainIdConfig {
        uint256 chainId;
        uint16 layerZeroChainId;
    }

    // This script is for StargateFacet (V1) only
    function run() public {
        // load config
        path = string.concat(root, "/config/stargate.json");
        json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(".chains");
        ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (ChainIdConfig[])
        );

        StargateFacet stargate = StargateFacet(diamond);

        vm.startBroadcast(deployerPrivateKey);

        for (uint256 i = 0; i < cidCfg.length; i++) {
            console.log("Setting Chain Id:");
            console.log(cidCfg[i].chainId);
            console.log(cidCfg[i].layerZeroChainId);
            stargate.setLayerZeroChainId(
                cidCfg[i].chainId,
                cidCfg[i].layerZeroChainId
            );
        }

        vm.stopBroadcast();
    }
}
