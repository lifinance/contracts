// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
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

    function run() public {
        address facet = json.readAddress(".StargateFacet");

        path = string.concat(root, "/config/stargate.json");
        json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(string.concat(".chains"));
        ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (ChainIdConfig[])
        );

        bytes memory rawPools = json.parseRaw(
            string.concat(".pools.", network)
        );
        PoolIdConfig[] memory poolCfg = abi.decode(rawPools, (PoolIdConfig[]));

        StargateFacet stargate = StargateFacet(diamond);

        vm.startBroadcast(deployerPrivateKey);

        for (uint256 i = 0; i < poolCfg.length; i++) {
            console.log("Setting Pool Id:");
            console.log(poolCfg[i].poolId);
            console.log(poolCfg[i].token);
            stargate.setStargatePoolId(poolCfg[i].token, poolCfg[i].poolId);
        }

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
