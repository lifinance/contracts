// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { IERC4626 } from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { InvalidConfig, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { TestBase } from "../utils/TestBase.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IOftERC4626 is IERC4626 {
    function transferShares(
        address to,
        uint256 shares
    ) external returns (uint256 assets);
    function assetsToShares(
        uint256 assets
    ) external view returns (uint256 shares);
}

contract LiFiDEXAggregatorApechainTest is TestBase {
    using SafeERC20 for IERC20;

    // ———————— CONFIG ————————
    address private constant APE_ETH =
        0xcF800F4948D16F23333508191B1B1591daF70438;
    address private constant WETH = 0xf4D9235269a96aaDaFc9aDAe454a0618eBE37949; // WTH
    address private constant ALGEBRA_POOL =
        address(0x217076aa74eFF7D54837D00296e9AEBc8c06d4F2); // the APE/USDC Algebra pool

    LiFiDEXAggregator public unpatched =
        LiFiDEXAggregator(payable(0x2D4ffb5219fC3C84905ec7CAEe2740d9dDa8271D));
    LiFiDEXAggregator public patched;

    address[] internal privileged;

    // Add these new test users after the existing constants
    address constant USER_A = address(0xA11CE);
    address constant USER_B = address(0xB0B);
    address constant USER_C = address(0xC1D);
    address constant REAL_TENDERLY_USER_SENDER =
        address(0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b);

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_APECHAIN";
        customBlockNumberForForking = 12912470;
        fork();

        privileged = new address[](2);
        privileged[0] = address(0xABC);
        privileged[1] = address(0xEBC);

        patched = new LiFiDEXAggregator(
            address(0xCAFE),
            privileged,
            USER_DIAMOND_OWNER
        ); // dont care about bento and privilaged users
        vm.label(address(patched), "LiFiDEXAggregator");
    }

    // @notice build the 1‑pool route for V3/Algebra swap
    function _buildRoute(
        address tokenIn,
        uint256 amountIn,
        address recipient
    ) internal view returns (bytes memory route, bool zeroForOne) {
        address pool = ALGEBRA_POOL;
        address token0 = IVelodromeV2Pool(pool).token0();
        zeroForOne = (tokenIn == token0);
        uint8 direction = zeroForOne ? 1 : 0;

        route = abi.encodePacked(
            uint8(2), // processUserERC20
            tokenIn, // ApeETH
            uint8(1), // one pool
            uint16(65535), // 100% share
            uint8(1), // poolType == 1 (V3 / Algebra)
            pool,
            direction,
            recipient
        );
    }

    /// @notice Attempt with the raw aggregator: we under‑pay by 1 and it reverts "IIA"
    function test_Revert_InsufficientInputRaw() public {
        uint256 amountIn = 534451326669177; // some test amount
        address holder = 0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b;
        vm.prank(holder);
        IERC20(APE_ETH).transfer(REAL_TENDERLY_USER_SENDER, amountIn);
        vm.startPrank(REAL_TENDERLY_USER_SENDER);
        IERC20(APE_ETH).approve(address(unpatched), amountIn);

        (bytes memory route, ) = _buildRoute(
            APE_ETH,
            amountIn,
            REAL_TENDERLY_USER_SENDER
        );
        vm.expectRevert(); // any revert from "insufficientInputAmount"
        unpatched.processRoute(
            APE_ETH,
            amountIn,
            WETH,
            0, // minOut = 0
            REAL_TENDERLY_USER_SENDER,
            route
        );
        vm.stopPrank();
    }

    /// @notice With the patched aggregator (snapshot‐before/after) the swap now succeeds
    function test_SucceedsAfterPatch() public {
        uint256 amountIn = 534451326669177;
        address holder = 0x1EA5Df273F1b2e0b10554C8F6f7Cc7Ef34F6a51b;
        vm.prank(holder);
        IERC20(APE_ETH).transfer(REAL_TENDERLY_USER_SENDER, amountIn);
        vm.startPrank(REAL_TENDERLY_USER_SENDER);
        IERC20(APE_ETH).approve(address(patched), amountIn);

        (bytes memory route, bool zf1) = _buildRoute(
            APE_ETH,
            amountIn,
            REAL_TENDERLY_USER_SENDER
        );
        // track USDC balance
        uint256 before = IERC20(WETH).balanceOf(REAL_TENDERLY_USER_SENDER);

        // this no longer reverts, and we get some USDC back
        patched.processRoute(
            APE_ETH,
            amountIn,
            WETH,
            0,
            REAL_TENDERLY_USER_SENDER,
            route
        );

        uint256 balanceAfter = IERC20(WETH).balanceOf(
            REAL_TENDERLY_USER_SENDER
        );
        assertGt(balanceAfter - before, 0, "should receive some USDC");
        vm.stopPrank();
    }

    // Add this helper function to get both asset and share balances
    function _getBalances(
        address user
    ) internal view returns (uint256 assets, uint256 shares) {
        assets = IERC20(APE_ETH).balanceOf(user);
        try IERC4626(APE_ETH).balanceOf(user) returns (uint256 _shares) {
            shares = _shares;
        } catch {
            shares = 0;
        }
    }

    // function test_ERC4626Transfers() public {
    //     // Initial setup - get tokens from a holder
    //     address holder = 0xFDAf8F210d52a3f8EE416ad06Ff4A0868bB649D4;
    //     uint256 amountIn = 534451326669178;
    //     address tokenIn = APE_ETH;

    //     // Transfer initial tokens to USER_A
    //     vm.startPrank(holder);
    //     IERC20(tokenIn).transfer(USER_A, amountIn);
    //     vm.stopPrank();

    //     // First transfer: USER_A -> USER_B via normal transfer
    //     uint256 balanceBeforeB = IERC20(tokenIn).balanceOf(USER_B);

    //     vm.startPrank(USER_A);
    //     IERC20(tokenIn).transfer(USER_B, amountIn);
    //     vm.stopPrank();

    //     uint256 balanceAfterB = IERC20(tokenIn).balanceOf(USER_B);
    //     uint256 actualIn = balanceAfterB - balanceBeforeB;

    //     emit log_named_uint("Actual tokens received by USER_B", actualIn);

    //     // Convert actualIn to shares using assetsToShares instead of convertToShares
    //     uint256 shares = IOftERC4626(tokenIn).assetsToShares(actualIn);
    //     emit log_named_uint("Shares calculated for transfer", shares);

    //     // Second transfer: USER_B -> USER_C via shares
    //     uint256 balanceBeforeC = IERC20(tokenIn).balanceOf(USER_C);

    //     vm.startPrank(USER_B);
    //     IOftERC4626(tokenIn).transferShares(USER_C, shares);
    //     vm.stopPrank();

    //     uint256 balanceAfterC = IERC20(tokenIn).balanceOf(USER_C);
    //     uint256 actualOut = balanceAfterC - balanceBeforeC;

    //     emit log_named_uint("Actual tokens received by USER_C", actualOut);

    //     // Compare the results
    //     assertEq(actualOut, actualIn, "Amount mismatch between transfers");
    // }
}
