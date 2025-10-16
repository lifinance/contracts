// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestAMM } from "../utils/TestAMM.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { LibSwap, TestBase } from "../utils/TestBase.sol";
import { SwapperV2 } from "lifi/Helpers/SwapperV2.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Stub SwapperV2 Contract
contract TestSwapperV2 is SwapperV2, TestWhitelistManagerBase {
    function doSwaps(LibSwap.SwapData[] calldata _swapData) public {
        _depositAndSwap(
            "",
            (_swapData[_swapData.length - 1].fromAmount * 95) / 100,
            _swapData,
            payable(address(0xb33f))
        );

        // Fake send to bridge
        ERC20 finalAsset = ERC20(
            _swapData[_swapData.length - 1].receivingAssetId
        );
        finalAsset.transfer(
            address(1337),
            finalAsset.balanceOf(address(this))
        );
    }

    function doSwapsWithLowSlippage(
        LibSwap.SwapData[] calldata _swapData
    ) public {
        _depositAndSwap(
            "",
            (_swapData[_swapData.length - 1].fromAmount * 70) / 100, // Lower slippage tolerance
            _swapData,
            payable(address(0xb33f))
        );

        // Fake send to bridge
        ERC20 finalAsset = ERC20(
            _swapData[_swapData.length - 1].receivingAssetId
        );
        finalAsset.transfer(
            address(1337),
            finalAsset.balanceOf(address(this))
        );
    }

    function doSwapsWithReserve(
        LibSwap.SwapData[] calldata _swapData,
        uint256 _nativeReserve
    ) public payable {
        _depositAndSwap(
            "",
            (_swapData[_swapData.length - 1].fromAmount * 70) / 100, // Lower slippage tolerance
            _swapData,
            payable(address(0xb33f)),
            _nativeReserve
        );

        // Fake send to bridge
        ERC20 finalAsset = ERC20(
            _swapData[_swapData.length - 1].receivingAssetId
        );
        uint256 finalBalance = finalAsset.balanceOf(address(this));
        if (finalBalance > 0) {
            finalAsset.transfer(address(1337), finalBalance);
        }
    }
}

contract SwapperV2Test is TestBase {
    TestAMM internal amm;
    TestSwapperV2 internal swapper;
    function setUp() public {
        initTestBase();

        amm = new TestAMM();
        swapper = new TestSwapperV2();

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = TestSwapperV2.doSwaps.selector;
        functionSelectors[1] = TestSwapperV2.doSwapsWithLowSlippage.selector;
        functionSelectors[2] = TestSwapperV2.doSwapsWithReserve.selector;
        functionSelectors[3] = TestWhitelistManagerBase
            .addToWhitelist
            .selector;
        functionSelectors[4] = TestWhitelistManagerBase
            .setFunctionWhitelistBySelector
            .selector;

        addFacet(diamond, address(swapper), functionSelectors);

        swapper = TestSwapperV2(address(diamond));
        swapper.addToWhitelist(address(amm));
        swapper.setFunctionWhitelistBySelector(bytes4(amm.swap.selector));
        swapper.setFunctionWhitelistBySelector(
            bytes4(amm.partialSwap.selector)
        );
    }

    function test_SwapCleanup() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);
        ERC20 token3 = new ERC20("Token 3", "T3", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token1),
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                token1,
                10_000 ether,
                token2,
                10_100 ether
            ),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token2),
            address(token3),
            10_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                token2,
                10_000 ether,
                token3,
                10_200 ether
            ),
            false
        );

        // 95%
        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        swapper.doSwaps(swapData);

        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token1.balanceOf(address(amm)), 0);
        assertEq(token2.balanceOf(address(0xb33f)), 100 ether);
        assertEq(token3.balanceOf(address(this)), 0);
        assertEq(token3.balanceOf(address(1337)), 10_200 ether);
    }

    function test_SwapMultiInOne() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);
        ERC20 token3 = new ERC20("Token 3", "T3", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token1),
            address(token3),
            10_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                token1,
                10_000 ether,
                token3,
                10_100 ether
            ),
            true
        );

        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token2),
            address(token3),
            10_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                token2,
                10_000 ether,
                token3,
                10_200 ether
            ),
            true
        );

        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        token2.mint(address(this), 10_000 ether);
        token2.approve(address(swapper), 10_000 ether);

        swapper.doSwaps(swapData);

        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token2.balanceOf(address(this)), 0);
        assertEq(token3.balanceOf(address(this)), 0);
        assertEq(token3.balanceOf(address(1337)), 20_300 ether);
    }

    function test_SingleSwap() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);

        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token1),
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                token1,
                10_000 ether,
                token2,
                10_100 ether
            ),
            true
        );
        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        swapper.doSwaps(swapData);

        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token1.balanceOf(address(amm)), 0);
        assertEq(token2.balanceOf(address(1337)), 10_100 ether);
    }

    function test_refundsLeftoverSingleInputToken() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);

        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token1),
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(
                amm.partialSwap.selector,
                token1,
                10_000 ether,
                token2,
                8_000 ether
            ),
            true
        );

        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        swapper.doSwapsWithLowSlippage(swapData);

        // Check that leftover input tokens (20% of 10_000 = 2_000) were sent to leftover receiver
        assertEq(token1.balanceOf(address(0xb33f)), 2_000 ether);
        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token2.balanceOf(address(1337)), 8_000 ether);
    }

    function test_refundsLeftoverSingleInputTokenWithReserve() public {
        // For now, let's test with ERC20 tokens since reserve only applies to native tokens
        // and the logic should still work (reserve = 0 for ERC20)
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);

        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token1),
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(
                amm.partialSwap.selector,
                token1,
                10_000 ether,
                token2,
                8_000 ether
            ),
            true
        );

        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        // Reserve 500 ether (should not apply to ERC20 tokens)
        swapper.doSwapsWithReserve(swapData, 500 ether);

        // Check that all leftover input tokens (2_000) were sent to leftover receiver
        // since reserve doesn't apply to ERC20 tokens
        assertEq(token1.balanceOf(address(0xb33f)), 2_000 ether);
        assertEq(token1.balanceOf(address(swapper)), 0); // No reserve for ERC20
        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token2.balanceOf(address(1337)), 8_000 ether);
    }

    function test_refundsLeftoverNativeTokenWithReserve() public {
        ERC20 token2 = new ERC20("Token 2", "T2", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);

        // Use native token (address(0)) as input to test reserve functionality
        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(0), // Native token
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(
                amm.partialSwap.selector,
                ERC20(address(0)),
                10_000 ether,
                token2,
                8_000 ether
            ),
            true
        );

        uint256 initialBalance0xb33f = address(0xb33f).balance;
        uint256 initialBalanceSwapper = address(swapper).balance;

        // Reserve 500 ether of native token
        swapper.doSwapsWithReserve{ value: 10_000 ether }(swapData, 500 ether);

        // Check that leftover native tokens minus reserve (2_000 - 500 = 1_500) were sent to leftover receiver
        assertEq(address(0xb33f).balance - initialBalance0xb33f, 1_500 ether);
        assertEq(address(swapper).balance - initialBalanceSwapper, 500 ether); // Reserve should remain
        assertEq(token2.balanceOf(address(1337)), 8_000 ether);
    }

    function test_refundsLeftoverMultipleInputTokens() public {
        ERC20 token1 = new ERC20("Token 1", "T1", 18);
        ERC20 token2 = new ERC20("Token 2", "T2", 18);
        ERC20 token3 = new ERC20("Token 3", "T3", 18);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);

        // First swap: partial swap leaving leftovers
        swapData[0] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token1),
            address(token2),
            10_000 ether,
            abi.encodeWithSelector(
                amm.partialSwap.selector,
                token1,
                10_000 ether,
                token2,
                8_000 ether
            ),
            true
        );

        // Second swap: normal swap
        swapData[1] = LibSwap.SwapData(
            address(amm),
            address(amm),
            address(token2),
            address(token3),
            8_000 ether,
            abi.encodeWithSelector(
                amm.swap.selector,
                token2,
                8_000 ether,
                token3,
                8_200 ether
            ),
            false
        );

        token1.mint(address(this), 10_000 ether);
        token1.approve(address(swapper), 10_000 ether);

        swapper.doSwapsWithLowSlippage(swapData);

        // Check that leftover input tokens from first swap were sent to leftover receiver
        assertEq(token1.balanceOf(address(0xb33f)), 2_000 ether);
        assertEq(token1.balanceOf(address(this)), 0);
        assertEq(token2.balanceOf(address(this)), 0);
        assertEq(token3.balanceOf(address(1337)), 8_200 ether);
    }
}
