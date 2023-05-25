// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { CelerCircleBridgeFacet } from "lifi/Facets/CelerCircleBridgeFacet.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, IDiamondCut.FacetCut[] memory cut)
    {
        address facet = json.readAddress(".CelerCircleBridgeFacet");

        vm.startBroadcast(deployerPrivateKey);

        // CelerCircleBridgeFacet
        bytes4[] memory exclude;
        buildDiamondCut(
            getSelectors("CelerCircleBridgeFacet", exclude),
            facet
        );
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
