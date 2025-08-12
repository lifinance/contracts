// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { UniV3StyleFacet } from "lifi/Periphery/Lda/Facets/UniV3StyleFacet.sol";
import { BaseUniV3StyleDexFacetTest } from "../BaseUniV3StyleDexFacet.t.sol";

contract EnosysDexV3FacetTest is BaseUniV3StyleDexFacetTest {
    /// @dev HLN token on Flare
    IERC20 internal constant HLN =
        IERC20(0x140D8d3649Ec605CF69018C627fB44cCC76eC89f);

    /// @dev USDT0 token on Flare
    IERC20 internal constant USDT0 =
        IERC20(0xe7cd86e13AC4309349F30B3435a9d337750fC82D);

    /// @dev The single EnosysDexV3 pool for HLN–USDT0
    address internal constant ENOSYS_V3_POOL =
        0xA7C9E7343bD8f1eb7000F25dE5aeb52c6B78B1b7;

    function _setupForkConfig() internal override {
        forkConfig = ForkConfig({
            rpcEnvName: "ETH_NODE_URI_FLARE",
            blockNumber: 42652369
        });
    }

    function _getCallbackSelector() internal pure override returns (bytes4) {
        return UniV3StyleFacet.enosysdexV3SwapCallback.selector;
    }

    function test_CanSwap() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(HLN),
                tokenOut: address(USDT0),
                amountIn: 1_000 * 1e18,
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessUserERC20
            }),
            ENOSYS_V3_POOL,
            SwapDirection.Token0ToToken1
        );
    }

    function test_CanSwap_FromDexAggregator() public override {
        _executeUniV3StyleSwap(
            SwapTestParams({
                tokenIn: address(HLN),
                tokenOut: address(USDT0),
                amountIn: 1_000 * 1e18 - 1, // Account for slot-undrain
                sender: USER_SENDER,
                recipient: USER_SENDER,
                commandType: CommandType.ProcessMyERC20
            }),
            ENOSYS_V3_POOL,
            SwapDirection.Token0ToToken1
        );
    }
}
