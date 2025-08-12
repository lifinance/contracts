// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract LaminarV3FacetTest is BaseUniV3StyleDexFacetTest {
    IERC20 internal constant WHYPE =
        IERC20(0x5555555555555555555555555555555555555555);
    IERC20 internal constant LHYPE =
        IERC20(0x5748ae796AE46A4F1348a1693de4b50560485562);

    address internal constant WHYPE_LHYPE_POOL =
        0xdAA8a66380fb35b35CB7bc1dBC1925AbfdD0ae45;

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_HYPEREVM",
            blockNumber: 4433562
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.laminarV3SwapCallback.selector;
    }

    function test_CanSwap() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(WHYPE),
                tokenOut: address(LHYPE),
                amountIn: 1_000 * 1e18,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            WHYPE_LHYPE_POOL,
            SwapDirection.Token0ToToken1
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(WHYPE),
                tokenOut: address(LHYPE),
                amountIn: 1_000 * 1e18 - 1, // Account for slot-undrain
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessMyERC20
            }),
            WHYPE_LHYPE_POOL,
            SwapDirection.Token0ToToken1
        );
    }
}
