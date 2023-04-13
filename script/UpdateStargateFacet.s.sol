// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import "forge-std/console.sol";
import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { StargateFacet } from "lifi/Facets/StargateFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct ChainIdConfig {
        uint256 chainId;
        uint16 layerZeroChainId;
    }

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".StargateFacet");

        path = string.concat(root, "/config/stargate.json");
        json = vm.readFile(path);
        bytes memory rawChains = json.parseRaw(string.concat(".chains"));
        ChainIdConfig[] memory cidCfg = abi.decode(
            rawChains,
            (ChainIdConfig[])
        );

        bytes memory callData = abi.encodeWithSelector(
            StargateFacet.initStargate.selector,
            cidCfg
        );

        vm.startBroadcast(deployerPrivateKey);

        // Stargate
        if (loupe.facetFunctionSelectors(facet).length == 0) {
            bytes4[] memory exclude = new bytes4[](1);
            exclude[0] = StargateFacet.initStargate.selector;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(facet),
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: getSelectors("StargateFacet", exclude)
                })
            );
            cutter.diamondCut(cut, address(facet), callData);
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
