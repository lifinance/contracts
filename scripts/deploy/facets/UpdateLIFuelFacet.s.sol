// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.17;

import { UpdateScriptBase } from "./utils/UpdateScriptBase.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { DiamondCutFacet, IDiamondCut } from "lifi/Facets/DiamondCutFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { LIFuelFacet } from "lifi/Facets/LIFuelFacet.sol";
import { DSTest } from "ds-test/test.sol";

contract DeployScript is UpdateScriptBase {
    using stdJson for string;

    function run()
        public
        returns (address[] memory facets, IDiamondCut.FacetCut[] memory cut)
    {
        address facet = json.readAddress(".LIFuelFacet");

        vm.startBroadcast(deployerPrivateKey);

        // add Amarok facet to diamond
        bytes4[] memory exclude;
        buildDiamondCut(getSelectors("LIFuelFacet", exclude), facet);
        if (cut.length > 0) {
            cutter.diamondCut(cut, address(0), "");
        }
        facets = loupe.facetAddresses();

        vm.stopBroadcast();
    }
}
