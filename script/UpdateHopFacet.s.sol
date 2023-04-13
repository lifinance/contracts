// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
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

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".HopFacet");

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

        vm.startBroadcast(deployerPrivateKey);

        // Hop
        if (loupe.facetFunctionSelectors(facet).length == 0) {
            bytes4[] memory exclude = new bytes4[](1);
            exclude[0] = HopFacet.initHop.selector;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(facet),
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: getSelectors("HopFacet", exclude)
                })
            );
            cutter.diamondCut(cut, facet, callData);
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
