// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract LaminarV3FacetTest is BaseUniV3StyleDexFacetTest {
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "hyperevm",
            blockNumber: 4433562
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.laminarV3SwapCallback.selector;
    }

    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x5555555555555555555555555555555555555555); // WHYPE
        tokenOut = IERC20(0x5748ae796AE46A4F1348a1693de4b50560485562); // LHYPE
        uniV3Pool = 0xdAA8a66380fb35b35CB7bc1dBC1925AbfdD0ae45; // WHYPE_LHYPE_POOL
    }
}
