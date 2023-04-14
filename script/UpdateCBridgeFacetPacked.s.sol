// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CBridgeFacetPacked } from "lifi/Facets/CBridgeFacetPacked.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run() public returns (address[] memory facets) {
        address facet = json.readAddress(".CBridgeFacetPacked");

        vm.startBroadcast(deployerPrivateKey);

        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("CBridgeFacetPacked", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(facet), callData);
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
