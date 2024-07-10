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
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed } from "lifi/Errors/GenericErrors.sol";

import { UniswapV2Router02 } from "../utils/Interfaces.sol";
import { TestHelpers, MockUniswapDEX, NonETHReceiver } from "../utils/TestHelpers.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

// Stub GenericSwapFacet Contract
contract TestGenericSwapFacetV3 is GenericSwapFacetV3, GenericSwapFacet {
    constructor(address _nativeAddress) GenericSwapFacetV3(_nativeAddress) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function removeDex(address _dex) external {
        LibAllowList.removeAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract TestGenericSwapFacet is GenericSwapFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function removeDex(address _dex) external {
        LibAllowList.removeAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GenericSwapFacetV3Test is TestHelpers {
    using SafeTransferLib for ERC20;

    // These values are for Mainnet
    address internal constant USDC_HOLDER =
        0x4B16c5dE96EB2117bBE5fd171E4d203624B014aa;
    address internal constant DAI_HOLDER =
        0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf;
    address internal constant SOME_WALLET =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
    address internal constant FEE_COLLECTOR =
        0xbD6C7B0d2f68c2b7805d88388319cfB6EcB50eA9;

    // -----

    TestGenericSwapFacet internal genericSwapFacet;
    TestGenericSwapFacetV3 internal genericSwapFacetV3;

    function setUp() public {
        customBlockNumberForForking = 19834820;
        initTestBase();

        diamond = createDiamond();
        genericSwapFacet = new TestGenericSwapFacet();
        genericSwapFacetV3 = new TestGenericSwapFacetV3(address(0));
        usdc = ERC20(USDC_ADDRESS);
        usdt = ERC20(USDT_ADDRESS);
        dai = ERC20(DAI_ADDRESS);
        weth = ERC20(WETH_ADDRESS);
        uniswap = UniswapV2Router02(UNISWAP_V2_ROUTER);
        feeCollector = FeeCollector(FEE_COLLECTOR);

        // add genericSwapFacet (v1) to diamond (for gas usage comparison)
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = genericSwapFacet.swapTokensGeneric.selector;
        functionSelectors[1] = genericSwapFacet.addDex.selector;
        functionSelectors[2] = genericSwapFacet.removeDex.selector;
        functionSelectors[3] = genericSwapFacet
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
        vm.label(ADDRESS_WETH, "WETH_TOKEN");
        vm.label(ADDRESS_DAI, "DAI_TOKEN");
        vm.label(ADDRESS_USDC, "USDC_TOKEN");
        vm.label(ADDRESS_UNISWAP, "ADDRESS_UNISWAP");
    }

    // SINGLE SWAP ERC20 >> ERC20
    function _produceSwapDataERC20ToERC20(
        address facetAddress
    )
        private
        returns (LibSwap.SwapData[] memory swapData, uint256 minAmountOut)
    {
        // Swap USDC to DAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        uint256 amountIn = 100 * 10 ** usdc.decimals();

        // Calculate minimum input amount
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        minAmountOut = amounts[0];

        // prepare swapData
        swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
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

        vm.startPrank(USDC_HOLDER);
        usdc.approve(facetAddress, amountIn);
        vm.stopPrank();
    }

    function test_CanSwapSingleERC20ToERC20_V1() public {
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20(address(genericSwapFacet));

        vm.startPrank(USDC_HOLDER);
        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 99491781613896927553;

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_DAI, // toAssetId,
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

        // bytes memory callData = abi.encodeWithSelector(
        //     genericSwapFacet.swapTokensGeneric.selector,
        //     "",
        //     "integrator",
        //     "referrer",
        //     payable(SOME_WALLET),
        //     minAmountOut,
        //     swapData
        // );

        // console.log("Calldata V1:");
        // console.logBytes(callData);

        // vm.stopPrank();
    }

    function test_CanSwapSingleERC20ToERC20_V2() public {
        // get swapData for USDC > DAI swap
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20(address(genericSwapFacet));

        // pre-register max approval between diamond and dex to get realistic gas usage
        // vm.startPrank(address(genericSwapFacet));
        // usdc.approve(swapData[0].approveTo, type(uint256).max);
        // vm.stopPrank();

        vm.startPrank(USDC_HOLDER);

        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 99491781613896927553;

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_DAI, // toAssetId,
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

        // bytes memory callData = abi.encodeWithSelector(
        //     genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector,
        //     "",
        //     "integrator",
        //     "referrer",
        //     payable(SOME_WALLET),
        //     minAmountOut,
        //     swapData[0]
        // );

        // console.log("Calldata V2:");
        // console.logBytes(callData);
        vm.stopPrank();
    }

    function test_WillRevertIfSlippageIsTooHighSingleERC20ToERC20() public {
        // get swapData for USDC > DAI swap
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20(address(genericSwapFacet));
        vm.startPrank(USDC_HOLDER);

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            ADDRESS_DAI,
            minAmountOut - 1,
            0
        );

        // update SwapData
        swapData[0].callTo = swapData[0].approveTo = address(mockDEX);

        vm.expectRevert(
            abi.encodeWithSelector(
                CumulativeSlippageTooHigh.selector,
                minAmountOut,
                minAmountOut - 1
            )
        );

        genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );

        vm.stopPrank();
    }

    function test_WillRevertIfDEXIsNotWhitelistedButApproveToIsSingleERC20()
        public
    {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20(address(genericSwapFacetV3));

        vm.startPrank(USDC_HOLDER);

        // update approveTo address in swapData
        swapData[0].approveTo = SOME_WALLET;

        vm.expectRevert(ContractCallNotAllowed.selector);

        genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );
    }

    function test_CanSwapSingleERC20ToERC20WithNonZeroAllowance() public {
        // get swapData for USDC > DAI swap
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20(address(genericSwapFacet));

        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 99491781613896927553;

        // pre-register max approval between diamond and dex to get realistic gas usage
        vm.startPrank(address(genericSwapFacet));
        usdc.approve(swapData[0].approveTo, 1);
        vm.stopPrank();

        vm.startPrank(USDC_HOLDER);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_DAI, // toAssetId,
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

        vm.stopPrank();
    }

    function test_CanSwapSingleERC20ToERC20WithZeroAllowance() public {
        // get swapData for USDC > DAI swap
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToERC20(address(genericSwapFacet));

        // expected exact amountOut based on the liquidity available in the specified block for this test case
        uint256 expAmountOut = 99491781613896927553;

        // pre-register max approval between diamond and dex to get realistic gas usage
        vm.startPrank(address(genericSwapFacet));
        usdc.approve(swapData[0].approveTo, 0);
        vm.stopPrank();

        vm.startPrank(USDC_HOLDER);

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_DAI, // toAssetId,
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

        vm.stopPrank();
    }

    // SINGLE SWAP ERC20 >> Native
    function _produceSwapDataERC20ToNative(
        address facetAddress
    )
        private
        returns (LibSwap.SwapData[] memory swapData, uint256 minAmountOut)
    {
        // Swap USDC to Native ETH
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WETH;

        minAmountOut = 2 ether;

        // Calculate minimum input amount
        uint256[] memory amounts = uniswap.getAmountsIn(minAmountOut, path);
        uint256 amountIn = amounts[0];

        // prepare swapData
        swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
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

        vm.startPrank(USDC_HOLDER);
        usdc.approve(facetAddress, amountIn);
        vm.stopPrank();
    }

    function test_CanSwapSingleERC20ToNative_V1() public {
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToNative(address(genericSwapFacet));

        vm.startPrank(USDC_HOLDER);

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
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
        ) = _produceSwapDataERC20ToNative(address(genericSwapFacet));

        // pre-register max approval between diamond and dex to get realistic gas usage
        vm.startPrank(address(genericSwapFacet));
        usdc.approve(swapData[0].approveTo, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USDC_HOLDER);

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
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

    function test_WillRevertIfSlippageIsTooHighSingleERC20ToNative() public {
        // get swapData USDC > ETH (native)
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToNative(address(genericSwapFacet));

        vm.startPrank(USDC_HOLDER);

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            address(0),
            minAmountOut - 1,
            0
        );

        // update SwapData
        swapData[0].callTo = swapData[0].approveTo = address(mockDEX);

        vm.expectRevert(
            abi.encodeWithSelector(
                CumulativeSlippageTooHigh.selector,
                minAmountOut,
                minAmountOut - 1
            )
        );

        genericSwapFacetV3.swapTokensSingleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );

        vm.stopPrank();
    }

    function test_ERC20SwapWillRevertIfSwapFails() public {
        // get swapData USDC > ETH (native)
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToNative(address(genericSwapFacet));

        vm.startPrank(USDC_HOLDER);

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            address(0),
            0,
            0
        );

        // update SwapData
        bytes memory revertReason = abi.encodePacked("Just because");
        swapData[0].callTo = swapData[0].approveTo = address(mockDEX);

        swapData[0].callData = abi.encodeWithSelector(
            mockDEX.mockSwapWillRevertWithReason.selector,
            revertReason
        );

        vm.expectRevert(revertReason);

        genericSwapFacetV3.swapTokensSingleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );

        vm.stopPrank();
    }

    function test_WillRevertIfDEXIsNotWhitelistedSingleERC20() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToNative(address(genericSwapFacetV3));

        vm.startPrank(USDC_HOLDER);

        // remove dex from whitelist
        genericSwapFacetV3.removeDex(ADDRESS_UNISWAP);

        vm.expectRevert(ContractCallNotAllowed.selector);

        genericSwapFacetV3.swapTokensSingleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );
    }

    function test_SingleERC20ToNativeWillRevertIfNativeAssetTransferFails()
        public
    {
        // get swapData USDC > ETH (native)
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataERC20ToNative(address(genericSwapFacet));

        vm.startPrank(USDC_HOLDER);

        // deploy a contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        vm.expectRevert(NativeAssetTransferFailed.selector);

        genericSwapFacetV3.swapTokensSingleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(address(nonETHReceiver)), // use nonETHReceiver for testing
            minAmountOut,
            swapData[0]
        );

        vm.stopPrank();
    }

    // SINGLE SWAP NATIVE >> ERC20
    function _produceSwapDataNativeToERC20()
        private
        view
        returns (LibSwap.SwapData[] memory swapData, uint256 minAmountOut)
    {
        // Swap native to USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

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
            ADDRESS_USDC,
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
            ADDRESS_USDC, // toAssetId,
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
            ADDRESS_USDC, // toAssetId,
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

    function test_WillRevertIfDEXIsNotWhitelistedSingleNative() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataNativeToERC20();

        // remove dex from whitelist
        genericSwapFacetV3.removeDex(ADDRESS_UNISWAP);

        vm.expectRevert(ContractCallNotAllowed.selector);

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
    }

    function test_NativeSwapWillRevertIfSwapFails() public {
        // get swapData USDC > ETH (native)
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataNativeToERC20();

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            address(0),
            0,
            0
        );

        // update SwapData
        bytes memory revertReason = abi.encodePacked("Some reason");
        swapData[0].callTo = swapData[0].approveTo = address(mockDEX);

        swapData[0].callData = abi.encodeWithSelector(
            mockDEX.mockSwapWillRevertWithReason.selector,
            revertReason
        );

        vm.expectRevert(revertReason);

        genericSwapFacetV3.swapTokensSingleV3NativeToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );
    }

    function test_WillRevertIfSlippageIsTooHighSingleNativeToERC20() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 minAmountOut
        ) = _produceSwapDataNativeToERC20();

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            ADDRESS_USDC,
            minAmountOut - 1,
            0
        );

        // update SwapData
        swapData[0].callTo = swapData[0].approveTo = address(mockDEX);

        vm.expectRevert(
            abi.encodeWithSelector(
                CumulativeSlippageTooHigh.selector,
                minAmountOut,
                minAmountOut - 1
            )
        );

        genericSwapFacetV3.swapTokensSingleV3NativeToERC20{ value: 2 ether }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData[0]
        );
    }

    // MULTISWAP FROM ERC20 TO ERC20

    function _produceSwapDataMultiswapFromERC20TOERC20(
        address facetAddress
    )
        private
        returns (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        )
    {
        // Swap1: USDC to DAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        amountIn = 10 * 10 ** usdc.decimals();

        // Calculate expected DAI amount to be received
        uint256[] memory amounts = uniswap.getAmountsOut(amountIn, path);
        uint256 swappedAmountDAI = amounts[0];

        // prepare swapData
        swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
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
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WETH;

        // Calculate required DAI input amount
        amounts = uniswap.getAmountsOut(swappedAmountDAI, path);
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_WETH,
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

        vm.startPrank(USDC_HOLDER);
        usdc.approve(facetAddress, 10 * 10 ** usdc.decimals());
    }

    function test_CanSwapMultipleFromERC20_V1() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20(
                address(genericSwapFacetV3)
            );

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_WETH, // toAssetId,
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

    function test_CanSwapMultipleFromERC20_V2() public {
        // ACTIVATE THIS CODE TO TEST GAS USAGE EXCL. MAX APPROVAL
        vm.startPrank(address(genericSwapFacet));
        dai.approve(address(uniswap), type(uint256).max);
        vm.stopPrank();

        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20(
                address(genericSwapFacetV3)
            );

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_USDC, // fromAssetId,
            ADDRESS_WETH, // toAssetId,
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

        // bytes memory callData = abi.encodeWithSelector(
        //     genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20.selector,
        //     "",
        //     "integrator",
        //     "referrer",
        //     payable(SOME_WALLET),
        //     minAmountOut,
        //     swapData
        // );

        // console.log("Calldata V2:");
        // console.logBytes(callData);

        vm.stopPrank();
    }

    function test_MultiSwapERC20WillRevertIfSwapFails() public {
        // get swapData USDC > ETH (native)
        (
            LibSwap.SwapData[] memory swapData,
            ,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20(
                address(genericSwapFacet)
            );

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            address(0),
            0,
            0
        );

        // update SwapData
        bytes memory revertReason = abi.encodePacked("Some reason");
        swapData[1].callTo = swapData[1].approveTo = address(mockDEX);

        swapData[1].callData = abi.encodeWithSelector(
            mockDEX.mockSwapWillRevertWithReason.selector,
            revertReason
        );

        vm.expectRevert(revertReason);

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );

        vm.stopPrank();
    }

    function test_WillRevertIfDEXIsNotWhitelistedMulti() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            ,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20(
                address(genericSwapFacetV3)
            );

        // remove dex from whitelist
        genericSwapFacetV3.removeDex(ADDRESS_UNISWAP);

        vm.expectRevert(ContractCallNotAllowed.selector);

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );
    }

    function test_WillRevertIfDEXIsNotWhitelistedButApproveToIsMulti() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            ,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20(
                address(genericSwapFacetV3)
            );

        // update approveTo address in swapData
        swapData[1].callTo = SOME_WALLET;

        vm.expectRevert(ContractCallNotAllowed.selector);

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );
    }

    function test_WillRevertIfSlippageIsTooHighMultiToERC20() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            ,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20(
                address(genericSwapFacetV3)
            );

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            ADDRESS_WETH,
            minAmountOut - 1,
            0
        );

        // update SwapData
        swapData[1].callTo = swapData[1].approveTo = address(mockDEX);

        vm.expectRevert(
            abi.encodeWithSelector(
                CumulativeSlippageTooHigh.selector,
                minAmountOut,
                minAmountOut - 1
            )
        );

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );

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
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_DAI;

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
            ADDRESS_DAI,
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
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        // Calculate required DAI input amount
        amounts = uniswap.getAmountsOut(swappedAmountDAI, path);
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_USDC,
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
            ADDRESS_USDC, // toAssetId,
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
            ADDRESS_USDC, // toAssetId,
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
    }

    function test_MultiSwapNativeWillRevertIfSwapFails() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromNativeToERC20();

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            address(0),
            0,
            0
        );

        // update SwapData
        bytes memory revertReason = abi.encodePacked("Some reason");
        swapData[0].callTo = swapData[0].approveTo = address(mockDEX);

        swapData[0].callData = abi.encodeWithSelector(
            mockDEX.mockSwapWillRevertWithReason.selector,
            revertReason
        );

        vm.expectRevert(revertReason);

        genericSwapFacetV3.swapTokensMultipleV3NativeToERC20{
            value: amountIn
        }(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );
    }

    function test_WillRevertIfDEXIsNotWhitelistedButApproveToIsMultiNative()
        public
    {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            ,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapFromERC20TOERC20(
                address(genericSwapFacetV3)
            );

        // update approveTo address in swapData
        swapData[0].approveTo = SOME_WALLET;

        vm.expectRevert(ContractCallNotAllowed.selector);

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );
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
            ADDRESS_DAI,
            ADDRESS_DAI,
            amountIn,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_DAI,
                integratorFee,
                lifiFee,
                integratorAddress
            ),
            true
        );

        uint256 amountOutFeeCollection = amountIn - integratorFee - lifiFee;

        // Swap2: DAI to USDC
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        // Calculate required DAI input amount
        uint256[] memory amounts = uniswap.getAmountsOut(
            amountOutFeeCollection,
            path
        );
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_DAI,
            ADDRESS_USDC,
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
            ADDRESS_DAI, // fromAssetId,
            ADDRESS_USDC, // toAssetId,
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
        vm.startPrank(address(genericSwapFacet));
        dai.approve(address(uniswap), type(uint256).max);
        vm.stopPrank();

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
            ADDRESS_DAI, // fromAssetId,
            ADDRESS_USDC, // toAssetId,
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
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

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
            ADDRESS_USDC,
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
            ADDRESS_USDC, // toAssetId,
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
            ADDRESS_USDC, // toAssetId,
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
    }

    // MULTISWAP COLLECT ERC20 FEE AND SWAP TO NATIVE

    function _produceSwapDataMultiswapERC20FeeAndSwapToNative(
        address facetAddress
    )
        private
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
            ADDRESS_DAI,
            ADDRESS_DAI,
            amountIn,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_DAI,
                integratorFee,
                lifiFee,
                integratorAddress
            ),
            true
        );

        uint256 amountOutFeeCollection = amountIn - integratorFee - lifiFee;

        // Swap2: DAI to native
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WETH;

        // Calculate required DAI input amount
        uint256[] memory amounts = uniswap.getAmountsOut(
            amountOutFeeCollection,
            path
        );
        minAmountOut = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_DAI,
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

        vm.startPrank(DAI_HOLDER);
        dai.approve(facetAddress, amountIn);
    }

    function test_CanCollectERC20FeesAndSwapToNative_V1() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToNative(
                address(genericSwapFacetV3)
            );

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_DAI, // fromAssetId,
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
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            uint256 amountIn,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToNative(
                address(genericSwapFacetV3)
            );

        uint256 gasLeftBef = gasleft();

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiGenericSwapCompleted(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator,
            "referrer", // referrer,
            SOME_WALLET, // receiver,
            ADDRESS_DAI, // fromAssetId,
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
    }

    function test_WillRevertIfSlippageIsTooHighMultiToNative() public {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            ,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToNative(
                address(genericSwapFacetV3)
            );

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            address(0),
            minAmountOut - 1,
            0
        );

        // update SwapData
        swapData[1].callTo = swapData[1].approveTo = address(mockDEX);

        vm.expectRevert(
            abi.encodeWithSelector(
                CumulativeSlippageTooHigh.selector,
                minAmountOut,
                minAmountOut - 1
            )
        );

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(SOME_WALLET), // receiver
            minAmountOut,
            swapData
        );

        vm.stopPrank();
    }

    function test_MultiSwapCollectERC20FeesAndSwapToNativeWillRevertIfNativeAssetTransferFails()
        public
    {
        // get swapData
        (
            LibSwap.SwapData[] memory swapData,
            ,
            uint256 minAmountOut
        ) = _produceSwapDataMultiswapERC20FeeAndSwapToNative(
                address(genericSwapFacetV3)
            );

        // deploy a contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        vm.expectRevert(NativeAssetTransferFailed.selector);

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative(
            "",
            "integrator",
            "referrer",
            payable(address(nonETHReceiver)),
            minAmountOut,
            swapData
        );
    }

    // Test functionality that refunds unused input tokens by DEXs
    function test_leavesNoERC20SendingAssetDustSingleSwap() public {
        vm.startPrank(USDC_HOLDER);
        uint256 initialBalance = usdc.balanceOf(USDC_HOLDER);

        uint256 amountIn = 100 * 10 ** usdc.decimals();
        uint256 amountInActual = (amountIn * 99) / 100; // 1% positive slippage
        uint256 expAmountOut = 100 * 10 ** dai.decimals();

        // deploy mockDEX to simulate positive slippage
        MockUniswapDEX mockDex = new MockUniswapDEX();

        // prepare swapData using MockDEX
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(mockDex),
            address(mockDex),
            ADDRESS_USDC,
            ADDRESS_DAI,
            amountIn,
            abi.encodeWithSelector(
                mockDex.swapTokensForExactTokens.selector,
                expAmountOut,
                amountIn,
                path,
                address(genericSwapFacet), // receiver
                block.timestamp + 20 minutes
            ),
            true
        );

        // fund DEX and set swap outcome
        deal(path[1], address(mockDex), expAmountOut);
        mockDex.setSwapOutput(
            amountInActual, // will only pull 99% of the amountIn that we usually expect to be pulled
            ERC20(path[1]),
            expAmountOut
        );

        // whitelist DEX & function selector
        genericSwapFacet.addDex(address(mockDex));
        genericSwapFacet.setFunctionApprovalBySignature(
            mockDex.swapTokensForExactTokens.selector
        );

        usdc.approve(address(genericSwapFacet), amountIn);

        genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator
            "referrer", // referrer
            payable(USDC_HOLDER), // receiver
            expAmountOut,
            swapData
        );

        assertEq(usdc.balanceOf(address(genericSwapFacet)), 0);
        assertEq(usdc.balanceOf(USDC_HOLDER), initialBalance - amountInActual);

        vm.stopPrank();
    }

    function test_leavesNoERC20SendingAssetDustMultiSwap() public {
        vm.startPrank(USDC_HOLDER);
        uint256 initialBalance = usdc.balanceOf(USDC_HOLDER);
        uint256 initialBalanceFeeCollector = usdc.balanceOf(FEE_COLLECTOR);
        uint256 initialBalanceDAI = dai.balanceOf(USDC_HOLDER);

        uint256 amountIn = 100 * 10 ** usdc.decimals();
        uint256 expAmountOut = 95 * 10 ** dai.decimals();

        // prepare swapData
        // Swap1: Collect ERC20 fee (5 USDC)
        uint integratorFee = 5 * 10 ** usdc.decimals();
        address integratorAddress = address(0xb33f); // some random address
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            FEE_COLLECTOR,
            FEE_COLLECTOR,
            ADDRESS_USDC,
            ADDRESS_USDC,
            amountIn,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_USDC,
                integratorFee,
                0, //lifiFee
                integratorAddress
            ),
            true
        );

        uint256 amountOutFeeCollection = amountIn - integratorFee;

        // deploy, fund and whitelist a MockDEX
        uint256 amountInActual = (amountOutFeeCollection * 99) / 100; // 1% positive slippage
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            ADDRESS_DAI,
            expAmountOut,
            amountInActual
        );

        // Swap2: Swap 95 USDC to DAI
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        swapData[1] = LibSwap.SwapData(
            address(mockDEX),
            address(mockDEX),
            ADDRESS_USDC,
            ADDRESS_DAI,
            amountOutFeeCollection,
            abi.encodeWithSelector(
                mockDEX.swapTokensForExactTokens.selector,
                expAmountOut,
                amountOutFeeCollection,
                path,
                address(genericSwapFacet), // receiver
                block.timestamp + 20 minutes
            ),
            false
        );

        usdc.approve(address(genericSwapFacet), amountIn);

        genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator
            "referrer", // referrer
            payable(USDC_HOLDER), // receiver
            expAmountOut,
            swapData
        );

        assertEq(usdc.balanceOf(address(genericSwapFacet)), 0);
        assertEq(
            usdc.balanceOf(FEE_COLLECTOR),
            initialBalanceFeeCollector + integratorFee
        );
        assertEq(
            usdc.balanceOf(USDC_HOLDER),
            initialBalance - amountInActual - integratorFee
        );
        assertEq(dai.balanceOf(USDC_HOLDER), initialBalanceDAI + expAmountOut);

        vm.stopPrank();
    }

    function test_leavesNoNativeSendingAssetDustSingleSwap() public {
        uint256 initialBalanceETH = address(SOME_WALLET).balance;
        uint256 initialBalanceUSDC = usdc.balanceOf(address(SOME_WALLET));

        uint256 amountIn = 1 ether;
        uint256 amountInActual = (amountIn * 99) / 100; // 1% positive slippage
        uint256 expAmountOut = 100 * 10 ** usdc.decimals();

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            ADDRESS_USDC,
            expAmountOut,
            amountInActual
        );

        // prepare swapData using MockDEX
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(mockDEX),
            address(mockDEX),
            address(0),
            ADDRESS_USDC,
            amountIn,
            abi.encodeWithSelector(
                mockDEX.swapETHForExactTokens.selector,
                expAmountOut,
                path,
                address(genericSwapFacet), // receiver
                block.timestamp + 20 minutes
            ),
            true
        );

        // execute the swap
        genericSwapFacetV3.swapTokensSingleV3NativeToERC20{ value: amountIn }(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator
            "referrer", // referrer
            payable(SOME_WALLET), // receiver
            expAmountOut,
            swapData
        );

        // we expect that the receiver has received the unused native tokens...
        assertEq(
            address(SOME_WALLET).balance,
            initialBalanceETH + (amountIn - amountInActual)
        );
        //... and that the swap result was received as well
        assertEq(
            usdc.balanceOf(SOME_WALLET),
            initialBalanceUSDC + expAmountOut
        );
    }

    function test_ReturnPositiveSlippageNativeWillRevertIfNativeTransferFails()
        public
    {
        uint256 amountIn = 1 ether;
        uint256 amountInActual = (amountIn * 99) / 100; // 1% positive slippage
        uint256 expAmountOut = 100 * 10 ** usdc.decimals();

        // deploy, fund and whitelist a MockDEX
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(genericSwapFacetV3),
            ADDRESS_USDC,
            expAmountOut,
            amountInActual
        );

        // prepare swapData using MockDEX
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(mockDEX),
            address(mockDEX),
            address(0),
            ADDRESS_USDC,
            amountIn,
            abi.encodeWithSelector(
                mockDEX.swapETHForExactTokens.selector,
                expAmountOut,
                path,
                address(genericSwapFacet), // receiver
                block.timestamp + 20 minutes
            ),
            true
        );

        // deploy a contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        vm.expectRevert(NativeAssetTransferFailed.selector);

        // execute the swap
        genericSwapFacetV3.swapTokensSingleV3NativeToERC20{ value: amountIn }(
            0x0000000000000000000000000000000000000000000000000000000000000000, // transactionId,
            "integrator", // integrator
            "referrer", // referrer
            payable(address(nonETHReceiver)), // receiver
            expAmountOut,
            swapData
        );
    }
}
