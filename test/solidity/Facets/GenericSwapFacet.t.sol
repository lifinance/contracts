// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { GenericSwapFacet } from "lifi/Facets/GenericSwapFacet.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { LibAllowList, LibSwap, TestBase, console, LiFiDiamond, ERC20 } from "../utils/TestBase.sol";

// Stub GenericSwapFacet Contract
contract TestGenericSwapFacet is GenericSwapFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GenericSwapFacetTest is TestBase {
    // These values are for Mainnet
    address internal constant USDC_HOLDER =
        0xee5B5B923fFcE93A870B3104b7CA09c3db80047A;
    address internal constant SOME_WALLET =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    // -----

    TestGenericSwapFacet internal genericSwapFacet;

    function setUp() public {
        customBlockNumberForForking = 15588208;
        initTestBase();

        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        genericSwapFacet = new TestGenericSwapFacet();

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = genericSwapFacet.swapTokensGeneric.selector;
        functionSelectors[1] = genericSwapFacet.addDex.selector;
        functionSelectors[2] = genericSwapFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(genericSwapFacet), functionSelectors);

        genericSwapFacet = TestGenericSwapFacet(address(diamond));
        genericSwapFacet.addDex(address(uniswap));
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(genericSwapFacet),
            "GenericSwapFacet"
        );
    }

    function testCanSwapERC20() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(
            address(genericSwapFacet),
            10_000 * 10 ** usdc.decimals()
        );

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountOut = 10 * 10 ** dai.decimals();

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                amountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_DAI, // toAssetId,
            amountIn, // fromAmount,
            10000000166486371895 // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            amountOut,
            swapData
        );

        vm.stopPrank();
    }

    function test_CanSwapMultiple() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(genericSwapFacet), 10 * 10 ** usdc.decimals());

        // Swap1: USDC to DAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountInUSDC = 10 * 10 ** usdc.decimals();

        // Calculate expected DAI amount to be received
        uint256[] memory amounts = uniswap.getAmountsOut(amountInUSDC, path);
        uint256 swappedAmountDAI = amounts[0];

        // prepare swapData
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
            amountInUSDC,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountInUSDC,
                swappedAmountDAI,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        // Swap2: DAI to WETH
        path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WETH;

        // Calculate required DAI input amount
        amounts = uniswap.getAmountsOut(swappedAmountDAI, path);
        uint256 amountOutWETH = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_WETH,
            swappedAmountDAI,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                swappedAmountDAI,
                amountOutWETH,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            false
        );

        uint256 expectedAmountOut = amountOutWETH;

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_WETH, // toAssetId,
            amountInUSDC, // fromAmount,
            expectedAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            expectedAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);

        vm.stopPrank();
    }
}
