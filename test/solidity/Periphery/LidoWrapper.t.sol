// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LidoWrapper, IStETH } from "lifi/Periphery/LidoWrapper.sol";
import { TestBase } from "../utils/TestBase.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract LidoWrapperTest is TestBase {
    LidoWrapper private lidoWrapper;
    address private constant ST_ETH_ADDRESS =
        0x76A50b8c7349cCDDb7578c6627e79b5d99D24138;
    address private constant WST_ETH_ADDRESS =
        0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb;
    address private constant ST_ETH_WHALE =
        0xa243e782185D5E25dEB3829E98E3Ed9cCecc35B2;

    function setUp() public {
        vm.label(ST_ETH_ADDRESS, "stETH");
        vm.label(WST_ETH_ADDRESS, "wstETH");

        // fork Optimism
        customRpcUrlForForking = "ETH_NODE_URI_OPTIMISM";
        customBlockNumberForForking = 135840744;
        initTestBase();

        // deploy lido wrapper
        lidoWrapper = new LidoWrapper(
            ST_ETH_ADDRESS,
            WST_ETH_ADDRESS,
            USER_DIAMOND_OWNER
        );

        // transfer stETH from whale to USER_SENDER
        vm.startPrank(ST_ETH_WHALE);
        IERC20(ST_ETH_ADDRESS).transfer(USER_SENDER, 50 ether);
        vm.stopPrank();

        // set max approvals from USER_SENDER to this contract
        vm.startPrank(USER_SENDER);
        // set max approval to stETH contract so it can pull tokens from user
        IERC20(ST_ETH_ADDRESS).approve(ST_ETH_ADDRESS, type(uint256).max);

        // deal wstETH to USER_SENDER by wrapping stETH
        IStETH(ST_ETH_ADDRESS).unwrap(10 ether);

        // IERC20(ST_ETH_ADDRESS).approve(address(this), type(uint256).max);
        IERC20(WST_ETH_ADDRESS).approve(
            address(lidoWrapper),
            type(uint256).max
        );

        vm.stopPrank();
    }

    function test_canUnwrapWstEthTokens() public {
        vm.startPrank(USER_SENDER);

        uint256 balanceStBefore = IERC20(ST_ETH_ADDRESS).balanceOf(
            USER_SENDER
        );
        uint256 balanceWstBefore = IERC20(WST_ETH_ADDRESS).balanceOf(
            USER_SENDER
        );

        lidoWrapper.unwrapWstETHToStETH(balanceWstBefore);

        uint256 balanceStAfter = IERC20(ST_ETH_ADDRESS).balanceOf(USER_SENDER);
        uint256 balanceWstAfter = IERC20(WST_ETH_ADDRESS).balanceOf(
            USER_SENDER
        );
        assertTrue(balanceStAfter > balanceStBefore);
        assertTrue(balanceWstAfter == 0);
    }

    function test_canWrapStEthTokens() public {
        vm.startPrank(USER_SENDER);

        uint256 stEthBalanceBefore = IERC20(ST_ETH_ADDRESS).balanceOf(
            USER_SENDER
        );
        uint256 wstEthBalanceBefore = IERC20(WST_ETH_ADDRESS).balanceOf(
            USER_SENDER
        );

        // Approve the LidoWrapper contract to spend stETH
        IERC20(ST_ETH_ADDRESS).approve(
            address(lidoWrapper),
            stEthBalanceBefore
        );

        // Wrap stETH to wstETH
        lidoWrapper.wrapStETHToWstETH(stEthBalanceBefore);

        uint256 stEthBalanceAfter = IERC20(ST_ETH_ADDRESS).balanceOf(
            USER_SENDER
        );
        uint256 wstEthBalance = IERC20(WST_ETH_ADDRESS).balanceOf(USER_SENDER);

        assertTrue(stEthBalanceAfter <= 1);
        assertTrue(wstEthBalance > wstEthBalanceBefore);

        vm.stopPrank();
    }
}
