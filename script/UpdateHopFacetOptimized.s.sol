// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { HopFacetOptimized } from "lifi/Facets/HopFacetOptimized.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    struct Config {
        address ammWrapper;
        address bridge;
        string name;
        address token;
    }

    address[] internal bridges;
    address[] internal tokensToApprove;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".HopFacetOptimized");

        path = string.concat(root, "/config/hop.json");
        json = vm.readFile(path);
        bytes memory rawConfig = json.parseRaw(
            string.concat(".", network, ".tokens")
        );
        Config[] memory configs = abi.decode(rawConfig, (Config[]));

        // Loop through all items in the config and
        // add the tokens and bridges to their respective arrays
        for (uint256 i = 0; i < configs.length; i++) {
            // if the token is address(0) (native) then skip it
            if (configs[i].token == address(0)) continue;
            bridges.push(
                configs[i].ammWrapper == address(0)
                    ? configs[i].bridge
                    : configs[i].ammWrapper
            );
            tokensToApprove.push(configs[i].token);
        }

        bytes memory callData = abi.encodeWithSelector(
            HopFacetOptimized.setApprovalForBridges.selector,
            bridges,
            tokensToApprove
        );

        vm.startBroadcast(deployerPrivateKey);

        // Hop Optimized
        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("HopFacetOptimized", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
