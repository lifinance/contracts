// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { DeBridgeFacet } from "lifi/Facets/DeBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".DeBridgeFacet");

        vm.startBroadcast(deployerPrivateKey);

        // DeBridge
        if (loupe.facetFunctionSelectors(facet).length == 0) {
            bytes4[] memory exclude;
            cut.push(
                IDiamondCut.FacetCut({
                    facetAddress: address(facet),
                    action: IDiamondCut.FacetCutAction.Add,
                    functionSelectors: getSelectors("DeBridgeFacet", exclude)
                })
            );
            cutter.diamondCut(cut, address(0), "");
        }

        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
