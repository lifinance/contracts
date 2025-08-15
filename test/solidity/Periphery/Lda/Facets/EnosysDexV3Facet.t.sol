// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract EnosysDexV3FacetTest is BaseUniV3StyleDexFacetTest {
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "flare",
            blockNumber: 42652369
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.enosysdexV3SwapCallback.selector;
    }

    function _setupDexEnv() internal override {
        tokenIn = IERC20(0x140D8d3649Ec605CF69018C627fB44cCC76eC89f); // HLN
        tokenOut = IERC20(0xe7cd86e13AC4309349F30B3435a9d337750fC82D); // USDT0
        uniV3Pool = 0xA7C9E7343bD8f1eb7000F25dE5aeb52c6B78B1b7; // ENOSYS_V3_POOL
    }
}
