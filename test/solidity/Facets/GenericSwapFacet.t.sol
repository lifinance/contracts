// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { GenericSwapFacet } from "lifi/Facets/GenericSwapFacet.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";

// Stub GenericSwapFacet Contract
contract TestGenericSwapFacet is GenericSwapFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GenericSwapFacetTest is DSTest, DiamondTest {
    event LiFiGenericSwapCompleted(
        bytes32 indexed transactionId,
        string integrator,
        string referrer,
        address receiver,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount
    );

    // These values are for Mainnet
    address internal constant USDC_ADDRESS =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant WETH_ADDRESS =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant DAI_ADDRESS =
        0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant USDC_HOLDER =
        0xee5B5B923fFcE93A870B3104b7CA09c3db80047A;
    address internal constant SOME_WALLET =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
    address internal constant UNISWAP_V2_ROUTER =
        0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;

    // -----

    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamond internal diamond;
    TestGenericSwapFacet internal genericSwapFacet;
    ERC20 internal usdc;
    ERC20 internal dai;
    ERC20 internal weth;
    UniswapV2Router02 internal uniswap;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        uint256 blockNumber = 15588208;
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        genericSwapFacet = new TestGenericSwapFacet();
        usdc = ERC20(USDC_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        weth = ERC20(WETH_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);

        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = genericSwapFacet
            .swapTokensSingleERC20ToERC20
            .selector;
        functionSelectors[1] = genericSwapFacet
            .swapTokensSingleERC20ToNative
            .selector;
        functionSelectors[2] = genericSwapFacet
            .swapTokensSingleNativeToERC20
            .selector;
        functionSelectors[3] = genericSwapFacet.swapTokensGeneric.selector;
        functionSelectors[4] = genericSwapFacet.addDex.selector;
        functionSelectors[5] = genericSwapFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(genericSwapFacet), functionSelectors);

        genericSwapFacet = TestGenericSwapFacet(address(diamond));
        genericSwapFacet.addDex(address(uniswap));
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector
        );

        vm.label(address(genericSwapFacet), "GenericSwapFacet");
        vm.label(WETH_ADDRESS, "WETH_TOKEN");
        vm.label(DAI_ADDRESS, "DAI_TOKEN");
        vm.label(USDC_ADDRESS, "USDC_TOKEN");
        vm.label(UNISWAP_V2_ROUTER, "UNISWAP_V2_ROUTER");
    }

    function test_CanSwapSingleERC20ToERC20_V1() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(
            address(genericSwapFacet),
            10_000 * 10 ** usdc.decimals()
        );

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;

        uint256 amountIn = 100 * 10 ** usdc.decimals();

        // Calculate minimum input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        uint256 minAmountOut = amounts[0];

        // prepare swapData
        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 99940753324315752385;

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            DAI_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            expAmountOut // toAmount (with liquidity in that selected block)
        );

        LibSwap.SwapData[] memory swapDataArr = new LibSwap.SwapData[](1);
        swapDataArr[0] = swapData;

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapDataArr
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V1", gasUsed);

        bytes memory callData = abi.encodeWithSelector(
            genericSwapFacet.swapTokensGeneric.selector,
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        console.log("Calldata V1:");
        console.logBytes(callData);

        vm.stopPrank();
    }

    function test_CanSwapSingleERC20ToERC20_V2() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(
            address(genericSwapFacet),
            10_000 * 10 ** usdc.decimals()
        );

        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;

        uint256 amountIn = 100 * 10 ** usdc.decimals();

        // Calculate minimum input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        uint256 minAmountOut = amounts[0];

        // prepare swapData
        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 99940753324315752385;

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            DAI_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            expAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensSingleERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V2", gasUsed);

        bytes memory callData = abi.encodeWithSelector(
            genericSwapFacet.swapTokensSingleERC20ToERC20.selector,
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        console.log("Calldata V2:");
        console.logBytes(callData);
        vm.stopPrank();
    }

    // function _getSwapdataSingleUniswap(
    //     address fromToken,
    //     address toTokenSwap,
    //     address receivingAssetId,
    //     bytes4 swapFunctionSelector,
    //     uint256 minAmountOut,
    //     address swapReceiver,
    //     bool depositRequired
    // ) internal returns (LibSwap.SwapData memory swapData) {
    //     // Swap USDC to native (ETH)
    //     address[] memory path = new address[](2);
    //     path[0] = fromToken;
    //     path[1] = toTokenSwap;

    //     // Calculate minimum input amount
    //     uint256[] memory amounts = uniswap.getAmountsIn(minAmountOut, path);
    //     uint256 amountIn = amounts[0];

    //     // prepare swapData
    //     swapData = LibSwap.SwapData(
    //         address(uniswap),
    //         address(uniswap),
    //         fromToken,
    //         receivingAssetId,
    //         amountIn,
    //         abi.encodeWithSelector(
    //             swapFunctionSelector,
    //             minAmountOut,
    //             amountIn,
    //             path,
    //             swapReceiver,
    //             block.timestamp + 20 minutes
    //         ),
    //         depositRequired
    //     );
    // }

    // function test_CanSwapSingleERC20ToNative() public {
    //     vm.startPrank(USDC_HOLDER);
    //     usdc.approve(
    //         address(genericSwapFacet),
    //         10_000 * 10 ** usdc.decimals()
    //     );

    //     // Swap USDC to native
    //     address[] memory path = new address[](2);
    //     path[0] = USDC_ADDRESS;
    //     path[1] = WETH_ADDRESS;

    //     uint256 minAmountOut = 2 ether;

    //     // Calculate minimum input amount
    //     uint256[] memory amounts = uniswap.getAmountsIn(minAmountOut, path);
    //     uint256 amountIn = amounts[0];

    //     // prepare swapData
    //     LibSwap.SwapData memory swapData = _getSwapdataSingleUniswap(
    //         USDC_ADDRESS,
    //         WETH_ADDRESS,
    //         uniswap.swapExactTokensForETH.selector,
    //         address(0),
    //         minAmountOut,
    //         address(genericSwapFacet),
    //         true
    //     );

    //     uint256 gasLeftBef = gasleft();

    //     vm.expectEmit(true, true, true, true, address(diamond));
    //     emit LiFiGenericSwapCompleted(
    //         0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
    //         "integrator", // integrator,
    //         "referrer", // referrer,
    //         SOME_WALLET, // receiver,
    //         USDC_ADDRESS, // fromAssetId,
    //         address(0), // toAssetId,
    //         amountIn, // fromAmount,
    //         minAmountOut // toAmount (with liquidity in that selected block)
    //     );

    //     genericSwapFacet.swapTokensSingleERC20ToNative(
    //         "",
    //         "integrator",
    //         "referrer",
    //         payable(SOME_WALLET), // receiver
    //         minAmountOut,
    //         swapData
    //     );

    //     uint256 gasUsed = gasLeftBef - gasleft();
    //     console.log("gas used V2: ", gasUsed);

    //     _testGasUsageV1(swapData, payable(SOME_WALLET), minAmountOut);

    //     vm.stopPrank();
    // }

    // function _testGasUsageV1(
    //     address payable receiver,
    //     uint256 minAmountOut
    // ) internal {
    //     //#------------------
    //     console.log("now trying the same with V1: ");

    //     LibSwap.SwapData memory swapData = _getSwapdataSingleUniswap(
    //         USDC_ADDRESS,
    //         WETH_ADDRESS,
    //         uniswap.swapExactTokensForETH.selector,
    //         address(0),
    //         minAmountOut,
    //         address(genericSwapFacet),
    //         true
    //     );
    //     swapDataArr[0] = swapData;

    //     uint256 gasLeftBef = gasleft();
    //     genericSwapFacet.swapTokensGeneric(
    //         "",
    //         "integrator",
    //         "referrer",
    //         receiver,
    //         minAmountOut,
    //         swapDataArr
    //     );

    //     uint256 gasUsed = gasLeftBef - gasleft();
    //     console.log("gas used V1: ", gasUsed);
    // }

    // function test_CanSwapSingleNativeToERC20() public {
    //     vm.startPrank(USDC_HOLDER);

    //     // Swap native to USDC
    //     address[] memory path = new address[](2);
    //     path[0] = WETH_ADDRESS;
    //     path[1] = USDC_ADDRESS;

    //     uint256 amountIn = 2 ether;

    //     // Calculate minimum input amount
    //     uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
    //     uint256 minAmountOut = amounts[1];

    //     // prepare swapData
    //     LibSwap.SwapData memory swapData = LibSwap.SwapData(
    //         address(uniswap),
    //         address(uniswap),
    //         WETH_ADDRESS,
    //         USDC_ADDRESS,
    //         amountIn,
    //         abi.encodeWithSelector(
    //             uniswap.swapExactETHForTokens.selector,
    //             minAmountOut,
    //             path,
    //             address(genericSwapFacet),
    //             block.timestamp + 20 minutes
    //         ),
    //         true
    //     );

    //     uint256 gasLeftBef = gasleft();

    //     vm.expectEmit(true, true, true, true, address(diamond));
    //     emit LiFiGenericSwapCompleted(
    //         0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
    //         "integrator", // integrator,
    //         "referrer", // referrer,
    //         SOME_WALLET, // receiver,
    //         WETH_ADDRESS, // fromAssetId,
    //         USDC_ADDRESS, // toAssetId,
    //         amountIn, // fromAmount,
    //         minAmountOut // toAmount (with liquidity in that selected block)
    //     );

    //     genericSwapFacet.swapTokensSingleNativeToERC20{ value: amountIn }(
    //         "",
    //         "integrator",
    //         "referrer",
    //         payable(SOME_WALLET), // receiver
    //         minAmountOut,
    //         swapData
    //     );

    //     uint256 gasUsed = gasLeftBef - gasleft();
    //     console.log("gas used: ", gasUsed);

    //     vm.stopPrank();
    // }

    function test_CanSwapMultiple() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(genericSwapFacet), 10 * 10 ** usdc.decimals());

        // Swap1: USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;

        uint256 amountInUSDC = 10 * 10 ** usdc.decimals();

        // Calculate expected DAI amount to be received
        uint256[] memory amounts = uniswap.getAmountsOut(amountInUSDC, path);
        uint256 swappedAmountDAI = amounts[0];

        // prepare swapData
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
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
        path[0] = DAI_ADDRESS;
        path[1] = WETH_ADDRESS;

        // Calculate required DAI input amount
        amounts = uniswap.getAmountsOut(swappedAmountDAI, path);
        uint256 amountOutWETH = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            WETH_ADDRESS,
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

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            WETH_ADDRESS, // toAssetId,
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

        vm.stopPrank();
    }
}
