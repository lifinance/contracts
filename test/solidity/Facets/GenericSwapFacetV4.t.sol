// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { GenericSwapFacetV4 } from "lifi/Facets/GenericSwapFacetV4.sol";
import { RouteProcessor4 } from "lifi/Periphery/RouteProcessor4.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed } from "lifi/Errors/GenericErrors.sol";

import { TestHelpers, MockUniswapDEX, NonETHReceiver, LiFiDiamond, LibSwap, LibAllowList, ERC20, console } from "../utils/TestHelpers.sol";

import { SafeTransferLib } from "solmate/utils/SafeTransferLib.sol"; // TODO: replace with SOLADY

// Stub GenericSwapFacet Contract
contract TestGenericSwapFacetV4 is GenericSwapFacetV4 {
    constructor(
        address _dexAggregatorAddress
    ) GenericSwapFacetV4(_dexAggregatorAddress) {}

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

contract TestGenericSwapFacetV3 is GenericSwapFacetV3 {
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

contract GenericSwapFacetV4Test is TestHelpers {
    using SafeTransferLib for ERC20;

    // These values are for Mainnet
    address internal constant USDC_HOLDER =
        0x4B16c5dE96EB2117bBE5fd171E4d203624B014aa;
    address internal constant DAI_HOLDER =
        0x40ec5B33f54e0E8A33A975908C5BA1c14e5BbbDf;
    address internal constant SOME_WALLET =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;

    TestGenericSwapFacetV3 internal genericSwapFacetV3;
    TestGenericSwapFacetV4 internal genericSwapFacetV4;
    RouteProcessor4 internal routeProcessor;

    uint256 defaultMinAmountOutNativeToERC20 = 2991350294;
    uint256 defaultMinAmountOutERC20ToNative = 32539678644151061;
    uint256 defaultMinAmountOutERC20ToERC20 = 99868787;

    function setUp() public {
        customBlockNumberForForking = 20266387;
        initTestBase();

        diamond = createDiamond();
        routeProcessor = new RouteProcessor4(address(0), new address[](0));
        genericSwapFacetV3 = new TestGenericSwapFacetV3();
        genericSwapFacetV4 = new TestGenericSwapFacetV4(
            address(routeProcessor)
        );

        // add genericSwapFacet (v3) to diamond (for gas usage comparison)
        bytes4[] memory functionSelectors = new bytes4[](9);
        functionSelectors[0] = genericSwapFacetV4
            .swapTokensSingleV3ERC20ToERC20
            .selector;
        functionSelectors[1] = genericSwapFacetV4
            .swapTokensSingleV3ERC20ToNative
            .selector;
        functionSelectors[2] = genericSwapFacetV4
            .swapTokensSingleV3NativeToERC20
            .selector;
        functionSelectors[3] = genericSwapFacetV4
            .swapTokensMultipleV3ERC20ToERC20
            .selector;
        functionSelectors[4] = genericSwapFacetV4
            .swapTokensMultipleV3ERC20ToNative
            .selector;
        functionSelectors[5] = genericSwapFacetV4
            .swapTokensMultipleV3NativeToERC20
            .selector;
        functionSelectors[6] = genericSwapFacetV4.addDex.selector;
        functionSelectors[7] = genericSwapFacetV4.removeDex.selector;
        functionSelectors[8] = genericSwapFacetV4
            .setFunctionApprovalBySignature
            .selector;

        // add v3 to diamond
        // v4 will be standalone, so we dont add it here
        addFacet(diamond, address(genericSwapFacetV3), functionSelectors);
        genericSwapFacetV3 = TestGenericSwapFacetV3(address(diamond));

        // whitelist dexAggregator dex with function selectors
        // v3
        genericSwapFacetV3.addDex(address(routeProcessor));
        genericSwapFacetV3.setFunctionApprovalBySignature(
            routeProcessor.processRoute.selector
        );

        // v4
        genericSwapFacetV4.addDex(address(routeProcessor));
        genericSwapFacetV4.setFunctionApprovalBySignature(
            routeProcessor.processRoute.selector
        );

        // whitelist feeCollector with function selectors
        // v3
        genericSwapFacetV3.addDex(address(feeCollector));
        genericSwapFacetV3.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );
        genericSwapFacetV3.setFunctionApprovalBySignature(
            feeCollector.collectNativeFees.selector
        );
        // v4
        genericSwapFacetV4.addDex(address(feeCollector));
        genericSwapFacetV4.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );
        genericSwapFacetV4.setFunctionApprovalBySignature(
            feeCollector.collectNativeFees.selector
        );

        vm.label(address(genericSwapFacetV3), "GenericSwapV3 via Diamond");
        vm.label(address(genericSwapFacetV4), "GenericSwapV4");
        vm.label(address(routeProcessor), "RouteProcessor");
        vm.label(ADDRESS_WETH, "WETH_TOKEN");
        vm.label(ADDRESS_DAI, "DAI_TOKEN");
        vm.label(ADDRESS_USDC, "USDC_TOKEN");
        vm.label(ADDRESS_USDT, "USDT_TOKEN");
        vm.label(ADDRESS_UNISWAP, "ADDRESS_UNISWAP");
    }

    // SINGLE NATIVE TO ERC20 (ETH > USDC)

    function test_CanExecuteSingleSwapNativeToERC20_V3()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_RECEIVER,
            int256(defaultMinAmountOutNativeToERC20)
        )
    {
        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV3).call{
            value: defaultNativeAmount
        }(_getGenericSwapCallDataSingle(true, SwapCase.NativeToERC20));
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V3", gasUsed);
    }

    function test_CanExecuteSingleSwapNativeToERC20_V4()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_RECEIVER,
            int256(defaultMinAmountOutNativeToERC20)
        )
    {
        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV4).call{
            value: defaultNativeAmount
        }(_getGenericSwapCallDataSingle(false, SwapCase.NativeToERC20));
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    // SINGLE ERC20 TO Native (USDC > ETH)

    function test_CanExecuteSingleSwapERC20ToNative_V3()
        public
        assertBalanceChange(
            address(0),
            USER_RECEIVER,
            int256(32610177968847511)
        )
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(genericSwapFacetV3), defaultUSDCAmount);

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV3).call(
            _getGenericSwapCallDataSingle(true, SwapCase.ERC20ToNative)
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V3", gasUsed);
    }

    function test_CanExecuteSingleSwapERC20ToNative_V4()
        public
        assertBalanceChange(
            address(0),
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToNative)
        )
    {
        // ensure that max approval exists from GenericSwapFacet to DEX aggregator
        vm.startPrank(address(genericSwapFacetV4));
        usdc.approve(address(routeProcessor), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(address(genericSwapFacetV4), defaultUSDCAmount);

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV4).call(
            _getGenericSwapCallDataSingle(false, SwapCase.ERC20ToNative)
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    // SINGLE ERC20 TO ERC20 (USDC > USDT)

    function test_CanExecuteSingleSwapERC20ToERC20_V3()
        public
        assertBalanceChange(
            ADDRESS_USDT,
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToERC20)
        )
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(genericSwapFacetV3), defaultUSDCAmount);

        uint256 gasLeftBef = gasleft();

        bytes memory callData = _getGenericSwapCallDataSingle(
            true,
            SwapCase.ERC20ToERC20
        );

        (bool success, ) = address(genericSwapFacetV3).call(
            _getGenericSwapCallDataSingle(true, SwapCase.ERC20ToERC20)
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V3", gasUsed);
    }

    function test_CanExecuteSingleSwapERC20ToERC20_V4()
        public
        assertBalanceChange(
            ADDRESS_USDT,
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToERC20)
        )
    {
        // ensure that max approval exists from GenericSwapFacet to DEX aggregator
        vm.startPrank(address(genericSwapFacetV4));
        usdc.approve(address(routeProcessor), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(address(genericSwapFacetV4), defaultUSDCAmount);

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV4).call(
            _getGenericSwapCallDataSingle(false, SwapCase.ERC20ToERC20)
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    // ------ HELPER FUNCTIONS

    enum SwapCase {
        NativeToERC20,
        ERC20ToERC20,
        ERC20ToNative
    }

    function _getValidDexAggregatorCalldata(
        bool isV3,
        SwapCase swapCase
    ) internal view returns (bytes memory callData) {
        if (swapCase == SwapCase.NativeToERC20) {
            if (isV3)
                // swapped tokens will be sent to diamond (and then forwarded to USER_RECEIVER by the facet)
                return
                    hex"2646478b000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000001ea36d8000000000000000000000000020C24B58c803c6e487a41D3Fd87788ef0bBdB2a00000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000700301ffff02012E8135bE71230c6B1B4045696d41C09Db0414226C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc204C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2002E8135bE71230c6B1B4045696d41C09Db041422600020C24B58c803c6e487a41D3Fd87788ef0bBdB2a0009c400000000000000000000000000000000";
            else {
                // swapped tokens will be sent directly to USER_RECEIVER
                return
                    hex"2646478b000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000000000000000000000000000002386f26fc10000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000001ea36d80000000000000000000000000000000000000000000000000000000abc65432100000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000000700301ffff02012E8135bE71230c6B1B4045696d41C09Db0414226C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc204C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2002E8135bE71230c6B1B4045696d41C09Db0414226000000000000000000000000000000000abC6543210009c400000000000000000000000000000000";
            }
        }
        if (swapCase == SwapCase.ERC20ToERC20) {
            if (isV3)
                // swapped tokens will be sent to diamond (and then forwarded to USER_RECEIVER by the facet)
                return
                    hex"2646478b000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec70000000000000000000000000000000000000000000000000000000005ec3e74000000000000000000000000020c24b58c803c6e487a41d3fd87788ef0bbdb2a00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000004502A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4801ffff003041CbD36888bECc7bbCBc0045E3B1f144466f5f01020C24B58c803c6e487a41D3Fd87788ef0bBdB2a000bb8000000000000000000000000000000000000000000000000000000";
            else {
                // swapped tokens will be sent directly to USER_RECEIVER
                return
                    hex"2646478b000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec70000000000000000000000000000000000000000000000000000000005edbbbb0000000000000000000000000000000000000000000000000000000abc65432100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000004502A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4801ffff003041CbD36888bECc7bbCBc0045E3B1f144466f5f010000000000000000000000000000000abC654321000bb8000000000000000000000000000000000000000000000000000000";
            }
        }
        if (swapCase == SwapCase.ERC20ToNative) {
            if (isV3) {
                // swapped tokens will be sent to diamond (and then forwarded to USER_RECEIVER by the facet)
                return
                    hex"2646478b000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000000000000000000000000000000000000000000000073467d7b86a48a000000000000000000000000020c24b58c803c6e487a41d3fd87788ef0bbdb2a00000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000007302A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4801ffff006E1fbeeABA87BAe1100d95f8340dc27aD7C8427b01F88d7F6357910E01e6e3A4f890B7Ca86471Eb6Ac000bb801C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc201ffff0200020C24B58c803c6e487a41D3Fd87788ef0bBdB2a00000000000000000000000000";
            } else {
                // swapped tokens will be sent directly to USER_RECEIVER
                return
                    hex"2646478b000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee000000000000000000000000000000000000000000000000007378cf172f087a0000000000000000000000000000000000000000000000000000000abc65432100000000000000000000000000000000000000000000000000000000000000c0000000000000000000000000000000000000000000000000000000000000007302A0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4801ffff00B4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc01F88d7F6357910E01e6e3A4f890B7Ca86471Eb6Ac000bb801C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc201ffff02000000000000000000000000000000000abC65432100000000000000000000000000";
            }
        }

        // should not reach this code
        revert(hex"dead");
    }

    function _getValidSingleSwapDataViaDexAggregator(
        bool isV3,
        SwapCase swapCase
    ) internal view returns (LibSwap.SwapData memory swapData) {
        (
            address sendingAssetId,
            address receivingAssetId,
            uint256 inputAmount
        ) = _getSwapDataParameters(swapCase);

        swapData = LibSwap.SwapData(
            address(routeProcessor),
            address(routeProcessor),
            sendingAssetId,
            receivingAssetId,
            inputAmount,
            _getValidDexAggregatorCalldata(isV3, swapCase),
            swapCase == SwapCase.NativeToERC20 ? false : true
        );
    }

    function _getValidMultiSwapData(
        bool isV3,
        SwapCase swapCase,
        bool fromNative
    ) internal view returns (LibSwap.SwapData[] memory swapData) {
        (
            address sendingAssetId,
            address receivingAssetId,
            uint256 inputAmount
        ) = _getSwapDataParameters(swapCase);

        swapData = new LibSwap.SwapData[](2);
        swapData[0] = _getFeeCollectorSwapData(fromNative);
        swapData[1] = LibSwap.SwapData(
            address(routeProcessor),
            address(routeProcessor),
            sendingAssetId,
            receivingAssetId,
            inputAmount,
            _getValidDexAggregatorCalldata(isV3, swapCase),
            swapCase == SwapCase.NativeToERC20 ? false : true
        );
    }

    function _getSwapDataParameters(
        SwapCase swapCase
    )
        internal
        view
        returns (
            address sendingAssetId,
            address receivingAssetId,
            uint256 inputAmount
        )
    {
        sendingAssetId = swapCase == SwapCase.NativeToERC20
            ? address(0)
            : ADDRESS_USDC;
        receivingAssetId = swapCase == SwapCase.ERC20ToNative
            ? address(0)
            : swapCase == SwapCase.ERC20ToERC20
            ? ADDRESS_USDT
            : ADDRESS_USDC;

        inputAmount = swapCase == SwapCase.NativeToERC20
            ? defaultNativeAmount
            : defaultUSDCAmount;
    }

    function _getGenericSwapCallDataSingle(
        bool isV3,
        SwapCase swapCase
    ) internal view returns (bytes memory callData) {
        bytes4 selector = swapCase == SwapCase.ERC20ToERC20
            ? genericSwapFacetV4.swapTokensSingleV3ERC20ToERC20.selector
            : swapCase == SwapCase.ERC20ToNative
            ? genericSwapFacetV4.swapTokensSingleV3ERC20ToNative.selector
            : genericSwapFacetV4.swapTokensSingleV3NativeToERC20.selector;

        uint256 minAmountOut = swapCase == SwapCase.ERC20ToERC20
            ? defaultMinAmountOutERC20ToERC20
            : swapCase == SwapCase.ERC20ToNative
            ? defaultMinAmountOutERC20ToNative
            : defaultMinAmountOutNativeToERC20;

        callData = _attachTransactionIdToCallData(
            abi.encodeWithSelector(
                selector,
                "",
                "",
                "",
                payable(USER_RECEIVER),
                minAmountOut,
                _getValidSingleSwapDataViaDexAggregator(isV3, swapCase)
            )
        );
    }

    function _attachTransactionIdToCallData(
        bytes memory callData
    ) internal pure returns (bytes memory adjustedCallData) {
        bytes memory delimiter = hex"deadbeef";
        bytes memory transactionID = hex"513ae98e50764707a4a573b35df47051";

        bytes memory mergedAppendix = mergeBytes(delimiter, transactionID);

        adjustedCallData = mergeBytes(callData, mergedAppendix);
    }
}
