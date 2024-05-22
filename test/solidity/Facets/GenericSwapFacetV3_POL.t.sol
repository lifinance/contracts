// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { Test, DSTest } from "forge-std/Test.sol";
import { console } from "../utils/Console.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";
import { Vm } from "forge-std/Vm.sol";
import { GenericSwapFacet } from "lifi/Facets/GenericSwapFacet.sol";
import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { MockUniswapDEX } from "../utils/MockUniswapDEX.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

// Stub GenericSwapFacet Contract
contract TestGenericSwapFacetV3 is GenericSwapFacetV3, GenericSwapFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract TestGenericSwapFacet is GenericSwapFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GenericSwapFacetV3POLTest is DSTest, DiamondTest, Test {
    using SafeTransferLib for ERC20;

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
        0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359;
    address internal constant USDT_ADDRESS =
        0xc2132D05D31c914a87C6611C10748AEb04B58e8F;
    address internal constant WETH_ADDRESS =
        0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270; // actually WMATIC
    address internal constant DAI_ADDRESS =
        0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063;
    address internal constant USDC_HOLDER =
        0xe7804c37c13166fF0b37F5aE0BB07A3aEbb6e245;
    address internal constant DAI_HOLDER =
        0x18dA62bA13Ae20007fd42961Fd52f3128B54E678;
    address internal constant SOME_WALLET =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
    address internal constant UNISWAP_V2_ROUTER =
        0xedf6066a2b290C185783862C7F4776A2C8077AD1;
    address internal constant FEE_COLLECTOR =
        0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9;

    // -----

    LiFiDiamond internal diamond;
    TestGenericSwapFacet internal genericSwapFacet;
    TestGenericSwapFacetV3 internal genericSwapFacetV3;
    ERC20 internal usdc;
    ERC20 internal usdt;
    ERC20 internal dai;
    ERC20 internal weth;
    UniswapV2Router02 internal uniswap;
    FeeCollector internal feeCollector;

    function fork() internal {
        string memory rpcUrl = vm.envString("ETH_NODE_URI_POLYGON");
        // uint256 blockNumber = 57209733;
        // uint256 blockNumber = 57216531; //TMP: REMOVE
        uint256 blockNumber = 57217659; //TMP: REMOVE
        vm.createSelectFork(rpcUrl, blockNumber);
    }

    function setUp() public {
        fork();

        diamond = createDiamond();
        genericSwapFacet = new TestGenericSwapFacet();
        genericSwapFacetV3 = new TestGenericSwapFacetV3();
        usdc = ERC20(USDC_ADDRESS);
        usdt = ERC20(USDT_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        weth = ERC20(WETH_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);
        feeCollector = FeeCollector(FEE_COLLECTOR);

        // add genericSwapFacet (v1) to diamond (for gas usage comparison)
        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = genericSwapFacet.swapTokensGeneric.selector;
        functionSelectors[1] = genericSwapFacet.addDex.selector;
        functionSelectors[2] = genericSwapFacet
            .setFunctionApprovalBySignature
            .selector;
        addFacet(diamond, address(genericSwapFacet), functionSelectors);

        // add genericSwapFacet (v3) to diamond
        bytes4[] memory functionSelectorsV3 = new bytes4[](6);
        functionSelectorsV3[0] = genericSwapFacetV3
            .swapTokensSingleV3ERC20ToERC20
            .selector;
        functionSelectorsV3[1] = genericSwapFacetV3
            .swapTokensSingleV3ERC20ToNative
            .selector;
        functionSelectorsV3[2] = genericSwapFacetV3
            .swapTokensSingleV3NativeToERC20
            .selector;
        functionSelectorsV3[3] = genericSwapFacetV3
            .swapTokensMultipleV3ERC20ToERC20
            .selector;
        functionSelectorsV3[4] = genericSwapFacetV3
            .swapTokensMultipleV3ERC20ToNative
            .selector;
        functionSelectorsV3[5] = genericSwapFacetV3
            .swapTokensMultipleV3NativeToERC20
            .selector;

        addFacet(diamond, address(genericSwapFacetV3), functionSelectorsV3);

        genericSwapFacet = TestGenericSwapFacet(address(diamond));
        genericSwapFacetV3 = TestGenericSwapFacetV3(address(diamond));

        // whitelist uniswap dex with function selectors
        // v1
        genericSwapFacet.addDex(address(uniswap));
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        genericSwapFacet.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector
        );
        // v3
        genericSwapFacetV3.addDex(address(uniswap));
        genericSwapFacetV3.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        genericSwapFacetV3.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        genericSwapFacetV3.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        genericSwapFacetV3.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector
        );

        // whitelist feeCollector with function selectors
        // v1
        genericSwapFacet.addDex(FEE_COLLECTOR);
        genericSwapFacet.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );
        genericSwapFacet.setFunctionApprovalBySignature(
            feeCollector.collectNativeFees.selector
        );
        // v3
        genericSwapFacetV3.addDex(FEE_COLLECTOR);
        genericSwapFacetV3.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );
        genericSwapFacetV3.setFunctionApprovalBySignature(
            feeCollector.collectNativeFees.selector
        );

        vm.label(address(genericSwapFacet), "LiFiDiamond");
        vm.label(WETH_ADDRESS, "WETH_TOKEN");
        vm.label(DAI_ADDRESS, "DAI_TOKEN");
        vm.label(USDC_ADDRESS, "USDC_TOKEN");
        vm.label(UNISWAP_V2_ROUTER, "UNISWAP_V2_ROUTER");
    }

    // ERC20 >> ERC20
    function _produceSwapDataERC20ToERC20()
        private
        view
        returns (LibSwap.SwapData[] memory swapData, uint256 minAmountOut)
    {
        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;

        uint256 amountIn = 100 * 10 ** usdc.decimals();

        // Calculate minimum input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        minAmountOut = amounts[0];

        // prepare swapData
        swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
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
    }

    function test_CanSwapSingleERC20ToERC20_V1() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(
            address(genericSwapFacet),
            10_000 * 10 ** usdc.decimals()
        );

        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20();

        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 148106061535636486;

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            DAI_ADDRESS, // toAssetId,
            swapData[0].fromAmount, // fromAmount,
            expAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
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
        // get swapData for USDC > DAI swap
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20();

        // // pre-register max approval between diamond and dex to get realistic gas usage
        vm.startPrank(address(genericSwapFacet));
        usdc.approve(swapData[0].approveTo, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USDC_HOLDER);
        usdc.approve(
            address(genericSwapFacet),
            10_000 * 10 ** usdc.decimals()
        );

        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 148106061535636486;

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            DAI_ADDRESS, // toAssetId,
            swapData[0].fromAmount, // fromAmount,
            expAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V2", gasUsed);

        bytes memory callData = abi.encodeWithSelector(
            genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData[0]
        );

        console.log("Calldata V2:");
        console.logBytes(callData);
        vm.stopPrank();
    }

    // ERC20 >> Native
    function _produceSwapDataERC20ToNative()
        private
        view
        returns (LibSwap.SwapData[] memory swapData, uint256 minAmountOut)
    {
        // Swap USDC to Native ETH
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = WETH_ADDRESS;

        minAmountOut = 2 ether;

        // Calculate minimum input amount
        uint256[] memory amounts = uniswap.getAmountsIn(minAmountOut, path);
        uint256 amountIn = amounts[0];

        // prepare swapData
        swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            address(0),
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapTokensForExactETH.selector,
                minAmountOut,
                amountIn,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            true
        );
    }

    function test_CanSwapSingleERC20ToNative_V1() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(
            address(genericSwapFacet),
            10_000 * 10 ** usdc.decimals()
        );

        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToNative();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            address(0), // toAssetId,
            swapData[0].fromAmount, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);

        vm.stopPrank();
    }

    function test_CanSwapSingleERC20ToNative_V2() public {
        // get swapData USDC > ETH (native)
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToNative();

        // pre-register max approval between diamond and dex to get realistic gas usage
        vm.startPrank(address(genericSwapFacet));
        usdc.approve(swapData[0].approveTo, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USDC_HOLDER);
        usdc.approve(
            address(genericSwapFacet),
            10_000 * 10 ** usdc.decimals()
        );

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            address(0), // toAssetId,
            swapData[0].fromAmount, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensSingleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);

        vm.stopPrank();
    }

    // NATIVE >> ERC20
    function _produceSwapDataNativeToERC20()
        private
        view
        returns (LibSwap.SwapData[] memory swapData, uint256 minAmountOut)
    {
        // Swap native to USDC
        address[] memory path = new address[](2);
        path[0] = WETH_ADDRESS;
        path[1] = USDC_ADDRESS;

        uint256 amountIn = 2 ether;

        // Calculate minimum input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        minAmountOut = amounts[1];

        // prepare swapData
        swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactETHForTokens.selector,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            true
        );
    }

    function test_CanSwapSingleNativeToERC20_V1() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataNativeToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            address(0), // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            swapData[0].fromAmount, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric{ value: swapData[0].fromAmount }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: ", gasUsed);
    }

    function test_CanSwapSingleNativeToERC20_V2() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataNativeToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            address(0), // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            swapData[0].fromAmount, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensSingleV3NativeToERC20{
            value: swapData[0].fromAmount
        }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);
    }

    // MULTISWAP FROM ERC20 TO ERC20

    function _produceSwapDataMultiswapFromERC20TOERC20()
        private
        view
        returns (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        )
    {
        // Swap1: USDC to DAI
        address[] memory path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = DAI_ADDRESS;

        amountIn = 10 * 10 ** usdc.decimals();

        // Calculate expected DAI amount to be received
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        uint256 swappedAmountDAI = amounts[0];

        // prepare swapData
        swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
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
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            WETH_ADDRESS,
            swappedAmountDAI,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                swappedAmountDAI,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            false
        );
    }

    function test_CanSwapMultipleERC20ToERC20_V1() public {
        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(genericSwapFacet), 10 * 10 ** usdc.decimals());

        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            WETH_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);

        vm.stopPrank();
    }

    function test_CanSwapMultipleERC20ToERC20_V2() public {
        // ACTIVATE THIS CODE TO TEST GAS USAGE EXCL. MAX APPROVAL
        // vm.startPrank(address(genericSwapFacet));
        // dai.approve(address(uniswap), type(uint256).max);
        // vm.stopPrank();

        vm.startPrank(USDC_HOLDER);
        usdc.approve(address(genericSwapFacet), 10 * 10 ** usdc.decimals());

        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            USDC_ADDRESS, // fromAssetId,
            WETH_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);

        bytes memory callData = abi.encodeWithSelector(
            genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20.selector,
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

    // MULTISWAP FROM NATIVE TO ERC20

    function _produceSwapDataMultiswapFromNativeToERC20()
        private
        view
        returns (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        )
    {
        // Swap1: Native to DAI
        address[] memory path = new address[](2);
        path[0] = WETH_ADDRESS;
        path[1] = DAI_ADDRESS;

        amountIn = 2 ether;

        // Calculate expected DAI amount to be received
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        uint256 swappedAmountDAI = amounts[1];

        // prepare swapData
        swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactETHForTokens.selector,
                swappedAmountDAI,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            true
        );

        // Swap2: DAI to USDC
        path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        // Calculate required DAI input amount
        amounts = uniswap.getAmountsOut(swappedAmountDAI, path);
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            USDC_ADDRESS,
            swappedAmountDAI,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                swappedAmountDAI,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            false
        );
    }

    function test_CanSwapMultipleFromNativeToERC20_V1() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromNativeToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            address(0), // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric{ value: amountIn }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);
    }

    function test_CanSwapMultipleFromNativeToERC20_V2() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromNativeToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            address(0), // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensMultipleV3NativeToERC20{
            value: amountIn
        }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);

        // console.log("amountIn:", amountIn);

        // bytes memory callData = abi.encodeWithSelector(
        //     genericSwapFacetV3.swapTokensMultipleV3NativeToERC20.selector,
        //     "",
        //     "integrator",
        //     "referrer",
        //     payable(SOME_WALLET),
        //     minAmountOut,
        //     swapData
        // );

        // console.log("Calldata V2:");
        // console.logBytes(callData);
    }

    // MULTISWAP FROM ERC20 TO NATIVE

    function _produceSwapDataMultiswapFromERC20ToNative()
        private
        view
        returns (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        )
    {
        // Swap1: DAI to USDC
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        amountIn = 10 * 10 ** dai.decimals();

        // Calculate expected DAI amount to be received
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        uint256 swapOutputAmount = amounts[1];

        // prepare swapData
        swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            USDC_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountIn,
                swapOutputAmount,
                path,
                address(genericSwapFacet),
                block.timestamp + 2000 minutes
            ),
            true
        );

        // Swap2: USDC to Native
        path = new address[](2);
        path[0] = USDC_ADDRESS;
        path[1] = WETH_ADDRESS;

        // Calculate minimum input amount
        amounts = uniswap.getAmountsOut(swapOutputAmount, path);
        minAmountOut = amounts[1];

        // prepare swapData
        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            USDC_ADDRESS,
            address(0),
            swapOutputAmount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector,
                swapOutputAmount,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            false
        );
    }

    function test_CanSwapMultipleFromERC20ToNative_V1() public {
        vm.startPrank(DAI_HOLDER);
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20ToNative();

        dai.approve(address(genericSwapFacet), amountIn);
        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            address(0), // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric{ value: amountIn }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);
    }

    function test_CanSwapMultipleFromERC20ToNative_V2() public {
        vm.startPrank(DAI_HOLDER);

        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20ToNative();

        dai.approve(address(genericSwapFacet), amountIn);

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            DAI_ADDRESS, // fromAssetId,
            address(0), // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);

        // bytes memory callData = abi.encodeWithSelector(
        //     genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative.selector,
        //     "",
        //     "integrator",
        //     "referrer",
        //     payable(SOME_WALLET),
        //     minAmountOut,
        //     swapData
        // );

        // console.log("Calldata V2:");
        // console.logBytes(callData);
    }

    // MULTISWAP COLLECT ERC20 FEE AND SWAP to ERC20

    function _produceSwapDataMultiswapERC20FeeAndSwapToERC20()
        private
        view
        returns (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        )
    {
        amountIn = 100 * 10 ** dai.decimals();

        uint integratorFee = 5 * 10 ** dai.decimals();
        uint lifiFee = 0;
        address integratorAddress = address(0xb33f); // some random address

        // Swap1: Collect ERC20 fee (DAI)
        // prepare swapData
        swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            FEE_COLLECTOR,
            FEE_COLLECTOR,
            DAI_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                DAI_ADDRESS,
                integratorFee,
                lifiFee,
                integratorAddress
            ),
            true
        );

        uint256 amountOutFeeCollection = amountIn - integratorFee - lifiFee;

        // Swap2: DAI to USDC
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = USDC_ADDRESS;

        // Calculate required DAI input amount
        uint256[] memory amounts = uniswap.getAmountsOut(
            amountOutFeeCollection,
            path
        );
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            USDC_ADDRESS,
            amountOutFeeCollection,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                amountOutFeeCollection,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            false
        );
    }

    function test_CanCollectERC20FeesAndSwapToERC20_V1() public {
        vm.startPrank(DAI_HOLDER);
        dai.approve(address(genericSwapFacet), 100 * 10 ** dai.decimals());

        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            DAI_ADDRESS, // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);

        vm.stopPrank();
    }

    function test_CanCollectERC20FeesAndSwapToERC20_V2() public {
        // ACTIVATE THIS CODE TO TEST GAS USAGE EXCL. MAX APPROVAL
        // vm.startPrank(address(genericSwapFacet));
        // dai.approve(address(uniswap), type(uint256).max);
        // vm.stopPrank();

        vm.startPrank(DAI_HOLDER);
        dai.approve(address(genericSwapFacet), 100 * 10 ** dai.decimals());

        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            DAI_ADDRESS, // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);

        vm.stopPrank();

        bytes memory callData = abi.encodeWithSelector(
            genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative.selector,
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        console.log("Calldata V2:");
        console.logBytes(callData);
    }

    // MULTISWAP COLLECT NATIVE FEE AND SWAP TO ERC20

    function _produceSwapDataMultiswapNativeFeeAndSwapToERC20()
        private
        view
        returns (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        )
    {
        amountIn = 1 ether;

        uint integratorFee = 0.1 ether;
        uint lifiFee = 0;
        address integratorAddress = address(0xb33f); // some random address

        // Swap1: Collect native fee
        // prepare swapData
        swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            FEE_COLLECTOR,
            FEE_COLLECTOR,
            address(0),
            address(0),
            amountIn,
            abi.encodeWithSelector(
                feeCollector.collectNativeFees.selector,
                integratorFee,
                lifiFee,
                integratorAddress
            ),
            true
        );

        uint256 amountOutFeeCollection = amountIn - integratorFee - lifiFee;

        // Swap2: native to USDC
        address[] memory path = new address[](2);
        path[0] = WETH_ADDRESS;
        path[1] = USDC_ADDRESS;

        // Calculate required DAI input amount
        uint256[] memory amounts = uniswap.getAmountsOut(
            amountOutFeeCollection,
            path
        );
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            USDC_ADDRESS,
            amountOutFeeCollection,
            abi.encodeWithSelector(
                uniswap.swapExactETHForTokens.selector,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            false
        );
    }

    function test_CanCollectNativeFeesAndSwap_V1() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapNativeFeeAndSwapToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            address(0), // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric{ value: amountIn }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);
    }

    function test_CanCollectNativeFeesAndSwap_V2() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapNativeFeeAndSwapToERC20();

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            address(0), // fromAssetId,
            USDC_ADDRESS, // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensMultipleV3NativeToERC20{
            value: amountIn
        }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);

        bytes memory callData = abi.encodeWithSelector(
            genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative.selector,
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        console.log("Calldata V2:");
        console.logBytes(callData);
    }

    // MULTISWAP COLLECT ERC20 FEE AND SWAP TO NATIVE

    function _produceSwapDataMultiswapERC20FeeAndSwapToNative()
        private
        view
        returns (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        )
    {
        amountIn = 100 * 10 ** dai.decimals();

        uint integratorFee = 5 * 10 ** dai.decimals();
        uint lifiFee = 0;
        address integratorAddress = address(0xb33f); // some random address

        // Swap1: Collect ERC20 fee (5 DAI)
        // prepare swapData
        swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            FEE_COLLECTOR,
            FEE_COLLECTOR,
            DAI_ADDRESS,
            DAI_ADDRESS,
            amountIn,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                DAI_ADDRESS,
                integratorFee,
                lifiFee,
                integratorAddress
            ),
            true
        );

        uint256 amountOutFeeCollection = amountIn - integratorFee - lifiFee;

        // Swap2: DAI to native
        address[] memory path = new address[](2);
        path[0] = DAI_ADDRESS;
        path[1] = WETH_ADDRESS;

        // Calculate required DAI input amount
        uint256[] memory amounts = uniswap.getAmountsOut(
            amountOutFeeCollection,
            path
        );
        minAmountOut = amounts[1];
        console.log("amounts[0]: ", amounts[0]);
        console.log("amounts[1]: ", amounts[1]);

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            DAI_ADDRESS,
            address(0),
            amountOutFeeCollection,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector,
                amountOutFeeCollection,
                minAmountOut,
                path,
                address(genericSwapFacet),
                block.timestamp + 20 minutes
            ),
            false
        );
    }

    function test_CanCollectERC20FeesAndSwapToNative_V1() public {
        vm.startPrank(DAI_HOLDER);
        console.log("balance DAI: ", dai.balanceOf(DAI_HOLDER));
        console.log("balance ETH SENDER: ", DAI_HOLDER.balance);
        console.log("balance ETH FACET : ", address(genericSwapFacet).balance);
        console.log("balance ETH RECEIVER : ", SOME_WALLET.balance);

        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToNative();

        dai.approve(address(genericSwapFacet), amountIn);
        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            DAI_ADDRESS, // fromAssetId,
            address(0), // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacet.swapTokensGeneric(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V1: ", gasUsed);
    }

    function test_CanCollectERC20FeesAndSwapToNative_V2() public {
        vm.startPrank(DAI_HOLDER);

        console.log("balance ETH SENDER: ", DAI_HOLDER.balance);
        console.log("balance ETH FACET : ", address(genericSwapFacet).balance);
        uint256 initBalance = SOME_WALLET.balance;
        console.log("balance ETH RECEIVER : ", initBalance);
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToNative();

        dai.approve(address(genericSwapFacet), amountIn);
        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            DAI_ADDRESS, // fromAssetId,
            address(0), // toAssetId,
            amountIn, // fromAmount,
            minAmountOut // toAmount (with liquidity in that selected block)
        );

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used V2: ", gasUsed);
        console.log("balance ETH SENDER: ", DAI_HOLDER.balance);
        console.log("balance ETH FACET : ", address(genericSwapFacet).balance);
        console.log("balance ETH RECEIVER : ", SOME_WALLET.balance);
        console.log(
            "differe ETH RECEIVER : ",
            SOME_WALLET.balance - initBalance
        );

        bytes memory callData = abi.encodeWithSelector(
            genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative.selector,
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET),
            minAmountOut,
            swapData
        );

        console.log("Calldata V2:");
        console.logBytes(callData);
    }
}
