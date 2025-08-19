// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IHyperswapV3Factory } from "lifi/Interfaces/IHyperswapV3Factory.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract HyperswapV3FacetTest is BaseUniV3StyleDexFacetTest {
    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            networkName: "hyperevm",
            blockNumber: 4433562
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.hyperswapV3SwapCallback.selector;
    }

    function _setupDexEnv() internal override {
        tokenIn = IERC20(0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb); // USDT0
        tokenOut = IERC20(0x5555555555555555555555555555555555555555); // WHYPE
        poolInOut = IHyperswapV3Factory(
            0xB1c0fa0B789320044A6F623cFe5eBda9562602E3
        ).getPool(address(tokenIn), address(tokenOut), 3000);
    }

    function _getDefaultAmountForTokenIn()
        internal
        pure
        override
        returns (uint256)
    {
        return 1_000 * 1e6;
    }
}
