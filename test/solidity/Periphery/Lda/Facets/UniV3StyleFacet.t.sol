// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { BaseDexFacetTest } from "../BaseDexFacet.t.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";

contract UniV3StyleFacetTest is BaseDexFacetTest {
    UniV3StyleFacet internal uniV3StyleFacet;

    function setUp() public {
        customBlockNumberForForking = 18277082;
        initTestBase();

        uniV3StyleFacet = new UniV3StyleFacet();
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = uniV3StyleFacet
            .swapUniV3
            .selector;
        functionSelectors[1] = uniV3StyleFacet
            .uniswapV3SwapCallback
            .selector;

        addFacet(address(ldaDiamond), address(uniV3StyleFacet), functionSelectors);
        uniV3StyleFacet = UniV3StyleFacet(address(ldaDiamond));

        setFacetAddressInTestBase(address(uniV3StyleFacet), "UniV3StyleFacet");
    }
}
