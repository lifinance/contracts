// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
<<<<<<<< HEAD:script/UpdatePeripheryRegistryFacet.s.sol
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
========
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { LIFuelFacet } from "lifi/Facets/LIFuelFacet.sol";
import {DSTest} from "ds-test/test.sol";
>>>>>>>> cf6b904 (chore: renamed getgas to lifuel (#223)):script/UpdateLIFuelFacet.s.sol

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
<<<<<<<< HEAD:script/UpdatePeripheryRegistryFacet.s.sol
        string memory path = string.concat(
            root,
            "/deployments/",
            network,
            ".",
            fileSuffix,
            "json"
        );
        string memory json = vm.readFile(path);
        address facet = json.readAddress(".PeripheryRegistryFacet");
========
        address facet = json.readAddress(".LIFuelFacet");
>>>>>>>> cf6b904 (chore: renamed getgas to lifuel (#223)):script/UpdateLIFuelFacet.s.sol

        vm.startBroadcast(deployerPrivateKey);

        // PeripheryRegistry
        if (loupe.facetFunctionSelectors(facet).length == 0) {
            bytes4[] memory exclude;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(facet),
                    action: IDiamondCut.FacetCutAction.Add,
<<<<<<<< HEAD:script/UpdatePeripheryRegistryFacet.s.sol
                    functionSelectors: getSelectors(
                        "PeripheryRegistryFacet",
                        exclude
                    )
========
                    functionSelectors: getSelectors("LIFuelFacet", exclude)
>>>>>>>> cf6b904 (chore: renamed getgas to lifuel (#223)):script/UpdateLIFuelFacet.s.sol
                })
            );
            cutter.diamondCut(cut, address(0), "");
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
