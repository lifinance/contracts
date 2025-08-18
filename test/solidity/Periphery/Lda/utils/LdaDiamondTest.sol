// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { BaseDiamondTest } from "../../../utils/BaseDiamondTest.sol";
import { TestBaseRandomConstants } from "../../../utils/TestBaseRandomConstants.sol";

contract LdaDiamondTest is BaseDiamondTest, TestBaseRandomConstants {
    LiFiDiamond internal ldaDiamond;

    function setUp() public virtual {
        ldaDiamond = createLdaDiamond(USER_DIAMOND_OWNER);
    }

    function createLdaDiamond(
        address _diamondOwner
    ) internal returns (LiFiDiamond) {
        vm.startPrank(_diamondOwner);
        DiamondCutFacet diamondCut = new DiamondCutFacet();
        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();
        OwnershipFacet ownership = new OwnershipFacet();
        LiFiDiamond diamond = new LiFiDiamond(
            _diamondOwner,
            address(diamondCut)
        );

        // Add Diamond Loupe
        _addDiamondLoupeSelectors(address(diamondLoupe));

        // Add Ownership
        _addOwnershipSelectors(address(ownership));

        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");
        delete cut;
        vm.stopPrank();
        return diamond;
    }
}
