// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { GenericSwapFacetV3 } from "lifi/Facets/GenericSwapFacetV3.sol";
import { GenericSwapper } from "lifi/Periphery/GenericSwapper.sol";
import { LiFiDEXAggregator } from "lifi/Periphery/LiFiDEXAggregator.sol";
import { ContractCallNotAllowed, CumulativeSlippageTooHigh, NativeAssetTransferFailed, UnAuthorized } from "lifi/Errors/GenericErrors.sol";

import { TestHelpers, MockUniswapDEX, NonETHReceiver, LiFiDiamond, LibSwap, LibAllowList, ERC20, console } from "../utils/TestHelpers.sol";

// Stub GenericSwapFacet Contract
contract TestGenericSwapper is GenericSwapper {
    constructor(
        address _dexAggregatorAddress,
        address _feeCollectorAddress
    ) GenericSwapper(_dexAggregatorAddress, _feeCollectorAddress) {}

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

contract GenericSwapperTest is TestHelpers {
    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    // These values are for Mainnet

    address internal constant ROUTE_PROCESSOR_NATIVE_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address internal constant USER_ADMIN =
        0x552008c0f6870c2f77e5cC1d2eb9bdff03e30Ea0;
    bytes constant CALLDATA_DELIMITER = hex"deadbeef";

    TestGenericSwapFacetV3 internal genericSwapFacetV3;
    TestGenericSwapper internal genericSwapper;
    LiFiDEXAggregator internal routeProcessor;

    uint256 defaultMinAmountOutNativeToERC20 = 2991350294;
    uint256 defaultMinAmountOutERC20ToNative = 32539678644151061;
    uint256 defaultMinAmountOutERC20ToERC20 = 99868787;
    uint256 actualAmpountOutERC20ToERC20 = 99868787;

    function setUp() public {
        customBlockNumberForForking = 20266387;
        initTestBase();

        diamond = createDiamond();
        routeProcessor = new LiFiDEXAggregator(address(0), new address[](0));
        genericSwapFacetV3 = new TestGenericSwapFacetV3(address(0));
        genericSwapper = new TestGenericSwapper(
            address(routeProcessor),
            address(feeCollector)
        );

        // add genericSwapFacet (v3) to diamond (for gas usage comparison)
        bytes4[] memory functionSelectors = new bytes4[](9);
        functionSelectors[0] = genericSwapFacetV3
            .swapTokensSingleV3ERC20ToERC20
            .selector;
        functionSelectors[1] = genericSwapFacetV3
            .swapTokensSingleV3ERC20ToNative
            .selector;
        functionSelectors[2] = genericSwapFacetV3
            .swapTokensSingleV3NativeToERC20
            .selector;
        functionSelectors[3] = genericSwapFacetV3
            .swapTokensMultipleV3ERC20ToERC20
            .selector;
        functionSelectors[4] = genericSwapFacetV3
            .swapTokensMultipleV3ERC20ToNative
            .selector;
        functionSelectors[5] = genericSwapFacetV3
            .swapTokensMultipleV3NativeToERC20
            .selector;
        functionSelectors[6] = genericSwapFacetV3.addDex.selector;
        functionSelectors[7] = genericSwapFacetV3.removeDex.selector;
        functionSelectors[8] = genericSwapFacetV3
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
        genericSwapper.addDex(address(routeProcessor));
        genericSwapper.setFunctionApprovalBySignature(
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
        genericSwapper.addDex(address(feeCollector));
        genericSwapper.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );
        genericSwapper.setFunctionApprovalBySignature(
            feeCollector.collectNativeFees.selector
        );

        vm.label(address(genericSwapFacetV3), "GenericSwapV3 via Diamond");
        vm.label(address(genericSwapper), "GenericSwapV4");
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

        (bool success, ) = address(genericSwapper).call{
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
        vm.startPrank(address(genericSwapper));
        usdc.approve(address(routeProcessor), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(address(genericSwapper), defaultUSDCAmount);

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapper).call(
            _getGenericSwapCallDataSingle(false, SwapCase.ERC20ToNative)
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    function test_CanSetApprovalsAndExecuteSingleSwapERC20ToNative_V4()
        public
        assertBalanceChange(
            address(0),
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToNative)
        )
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(genericSwapper), defaultUSDCAmount);

        vm.expectEmit(true, true, true, true, address(routeProcessor));
        emit Route(
            address(genericSwapper),
            USER_RECEIVER,
            ADDRESS_USDC,
            ROUTE_PROCESSOR_NATIVE_ADDRESS,
            defaultUSDCAmount,
            32502453164247162, // AmountOut determined by processRoute calldata
            defaultMinAmountOutERC20ToNative
        );

        genericSwapper.setApprovalForTokensAndSwap(
            _getTokenApprovals(),
            _getGenericSwapCallDataSingle(false, SwapCase.ERC20ToNative)
        );
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
        vm.startPrank(address(genericSwapper));
        usdc.approve(address(routeProcessor), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(address(genericSwapper), defaultUSDCAmount);

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapper).call(
            _getGenericSwapCallDataSingle(false, SwapCase.ERC20ToERC20)
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    // FEE COLLECTION + SWAP NATIVE TO ERC20 (ETH > USDC)

    function test_CanExecuteFeeCollectionPlusSwapNativeToERC20_V3()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_RECEIVER,
            int256(defaultMinAmountOutNativeToERC20)
        )
    {
        vm.startPrank(USER_SENDER);
        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV3).call{
            value: defaultNativeAmount + defaultNativeFeeCollectionAmount
        }(
            _getGenericSwapCallDataFeeCollectionPlusSwap(
                true,
                SwapCase.NativeToERC20
            )
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V3", gasUsed);
    }

    function test_CanExecuteFeeCollectionPlusSwapNativeToERC20_V4()
        public
        assertBalanceChange(
            ADDRESS_USDC,
            USER_RECEIVER,
            int256(defaultMinAmountOutNativeToERC20)
        )
    {
        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapper).call{
            value: defaultNativeAmount + defaultNativeFeeCollectionAmount
        }(
            _getGenericSwapCallDataFeeCollectionPlusSwap(
                false,
                SwapCase.NativeToERC20
            )
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    // FEE COLLECTION + SWAP  ERC20 TO Native (USDC > ETH)

    function test_CanExecuteFeeCollectionPlusSwapERC20ToNative_V3()
        public
        assertBalanceChange(
            address(0),
            USER_RECEIVER,
            int256(32610177968847511)
        )
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(
            address(genericSwapFacetV3),
            defaultUSDCAmount + defaultUSDCFeeCollectionAmount
        );

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV3).call(
            _getGenericSwapCallDataFeeCollectionPlusSwap(
                true,
                SwapCase.ERC20ToNative
            )
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V3", gasUsed);
    }

    function test_CanExecuteFeeCollectionPlusSwapERC20ToNative_V4()
        public
        assertBalanceChange(
            address(0),
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToNative)
        )
    {
        // ensure that max approval exists from GenericSwapFacet to DEX aggregator and FeeCollector
        vm.startPrank(address(genericSwapper));
        usdc.approve(address(routeProcessor), type(uint256).max);
        usdc.approve(address(feeCollector), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(
            address(genericSwapper),
            defaultUSDCAmount + defaultUSDCFeeCollectionAmount
        );

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapper).call(
            _getGenericSwapCallDataFeeCollectionPlusSwap(
                false,
                SwapCase.ERC20ToNative
            )
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    // FEE COLLECTION + SWAP  ERC20 TO ERC20 (USDC > USDT)

    function test_CanExecuteFeeCollectionPlusSwapERC20ToERC20_V3()
        public
        assertBalanceChange(
            ADDRESS_USDT,
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToERC20)
        )
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(
            address(genericSwapFacetV3),
            defaultUSDCAmount + defaultUSDCFeeCollectionAmount
        );

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapFacetV3).call(
            _getGenericSwapCallDataFeeCollectionPlusSwap(
                true,
                SwapCase.ERC20ToERC20
            )
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V3", gasUsed);
    }

    function test_CanExecuteFeeCollectionPlusSwapERC20ToERC20_V4()
        public
        assertBalanceChange(
            ADDRESS_USDT,
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToERC20)
        )
    {
        // ensure that max approval exists from GenericSwapFacet to DEX aggregator and FeeCollector
        vm.startPrank(address(genericSwapper));
        usdc.approve(address(routeProcessor), type(uint256).max);
        usdc.approve(address(feeCollector), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(USER_SENDER);
        usdc.approve(
            address(genericSwapper),
            defaultUSDCAmount + defaultUSDCFeeCollectionAmount
        );

        uint256 gasLeftBef = gasleft();

        (bool success, ) = address(genericSwapper).call(
            _getGenericSwapCallDataFeeCollectionPlusSwap(
                false,
                SwapCase.ERC20ToERC20
            )
        );
        if (!success) revert();

        uint256 gasUsed = gasLeftBef - gasleft();
        console.log("gas used: V4", gasUsed);
    }

    function test_CanSetApprovalsAndExecuteFeeCollectionPlusSwapERC20ToERC20_V4()
        public
        assertBalanceChange(
            ADDRESS_USDT,
            USER_RECEIVER,
            int256(defaultMinAmountOutERC20ToERC20)
        )
    {
        vm.startPrank(USER_SENDER);
        usdc.approve(
            address(genericSwapper),
            defaultUSDCAmount + defaultUSDCFeeCollectionAmount
        );

        vm.expectEmit(true, true, true, true, address(routeProcessor));
        emit Route(
            address(genericSwapper),
            USER_RECEIVER,
            ADDRESS_USDC,
            ADDRESS_USDT,
            defaultUSDCAmount,
            99466171, // AmountOut determined by processRoute calldata
            defaultMinAmountOutERC20ToERC20
        );

        genericSwapper.setApprovalForTokensAndSwap(
            _getTokenApprovals(),
            _getGenericSwapCallDataFeeCollectionPlusSwap(
                false,
                SwapCase.ERC20ToERC20
            )
        );
    }

    function test_AdminCanUpdateTokenApprovals() public {
        assertEq(
            usdc.allowance(address(genericSwapper), address(routeProcessor)),
            0
        );
        assertEq(
            usdt.allowance(address(genericSwapper), address(routeProcessor)),
            0
        );
        assertEq(
            dai.allowance(address(genericSwapper), address(routeProcessor)),
            0
        );

        address[] memory approvals = _getTokenApprovals();

        vm.startPrank(USER_ADMIN);
        genericSwapper.setApprovalForTokens(approvals);

        assertEq(
            usdc.allowance(address(genericSwapper), address(routeProcessor)),
            type(uint256).max
        );
        assertEq(
            usdt.allowance(address(genericSwapper), address(feeCollector)),
            type(uint256).max
        );
        assertEq(
            dai.allowance(address(genericSwapper), address(feeCollector)),
            0
        );
    }

    // ------ HELPER FUNCTIONS

    function _getTokenApprovals()
        internal
        view
        returns (address[] memory approvals)
    {
        approvals = new address[](2);
        approvals[0] = ADDRESS_USDC;
        approvals[1] = ADDRESS_USDT;
    }

    enum SwapCase {
        NativeToERC20,
        ERC20ToERC20,
        ERC20ToNative
    }

    function _getValidDexAggregatorCalldata(
        bool isV3,
        SwapCase swapCase
    ) internal pure returns (bytes memory callData) {
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
        SwapCase swapCase
    ) internal view returns (LibSwap.SwapData[] memory swapData) {
        (
            address sendingAssetId,
            address receivingAssetId,
            uint256 inputAmount
        ) = _getSwapDataParameters(swapCase);

        swapData = new LibSwap.SwapData[](2);
        swapData[0] = _getFeeCollectorSwapData(
            swapCase == SwapCase.NativeToERC20 ? true : false
        );

        swapData[1] = LibSwap.SwapData(
            address(routeProcessor),
            address(routeProcessor),
            sendingAssetId,
            receivingAssetId,
            inputAmount,
            _getValidDexAggregatorCalldata(isV3, swapCase),
            false
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
        bytes4 selector = isV3
            ? swapCase == SwapCase.ERC20ToERC20
                ? genericSwapFacetV3.swapTokensSingleV3ERC20ToERC20.selector
                : swapCase == SwapCase.ERC20ToNative
                ? genericSwapFacetV3.swapTokensSingleV3ERC20ToNative.selector
                : genericSwapFacetV3.swapTokensSingleV3NativeToERC20.selector
            : swapCase == SwapCase.ERC20ToERC20
            ? genericSwapper.swapTokensSingleV3ERC20ToERC20.selector
            : swapCase == SwapCase.ERC20ToNative
            ? genericSwapper.swapTokensSingleV3ERC20ToNative.selector
            : genericSwapper.swapTokensSingleV3NativeToERC20.selector;

        uint256 minAmountOut = swapCase == SwapCase.ERC20ToERC20
            ? defaultMinAmountOutERC20ToERC20
            : swapCase == SwapCase.ERC20ToNative
            ? defaultMinAmountOutERC20ToNative
            : defaultMinAmountOutNativeToERC20;

        callData = _attachTransactionIdToCallData(
            isV3
                ? abi.encodeWithSelector(
                    selector,
                    "",
                    "",
                    "",
                    payable(USER_RECEIVER),
                    minAmountOut,
                    _getValidSingleSwapDataViaDexAggregator(isV3, swapCase)
                )
                : abi.encodeWithSelector(
                    selector,
                    payable(USER_RECEIVER),
                    minAmountOut,
                    _getValidSingleSwapDataViaDexAggregator(isV3, swapCase)
                )
        );
    }

    function _getGenericSwapCallDataFeeCollectionPlusSwap(
        bool isV3,
        SwapCase swapCase
    ) internal view returns (bytes memory callData) {
        bytes4 selector = isV3
            ? swapCase == SwapCase.NativeToERC20
                ? genericSwapFacetV3.swapTokensMultipleV3NativeToERC20.selector
                : swapCase == SwapCase.ERC20ToERC20
                ? genericSwapFacetV3.swapTokensMultipleV3ERC20ToERC20.selector
                : genericSwapFacetV3.swapTokensMultipleV3ERC20ToNative.selector
            : swapCase == SwapCase.NativeToERC20
            ? genericSwapper.swapTokensMultipleV3NativeToERC20.selector
            : genericSwapper.swapTokensMultipleV3ERC20ToAny.selector;

        uint256 minAmountOut = swapCase == SwapCase.ERC20ToERC20
            ? defaultMinAmountOutERC20ToERC20
            : swapCase == SwapCase.ERC20ToNative
            ? defaultMinAmountOutERC20ToNative
            : defaultMinAmountOutNativeToERC20;

        callData = _attachTransactionIdToCallData(
            isV3
                ? abi.encodeWithSelector(
                    selector,
                    "",
                    "",
                    "",
                    payable(USER_RECEIVER),
                    minAmountOut,
                    _getValidMultiSwapData(isV3, swapCase)
                )
                : abi.encodeWithSelector(
                    selector,
                    payable(USER_RECEIVER),
                    minAmountOut,
                    _getValidMultiSwapData(isV3, swapCase)
                )
        );
    }

    function _attachTransactionIdToCallData(
        bytes memory callData
    ) internal pure returns (bytes memory adjustedCallData) {
        bytes memory transactionID = hex"513ae98e50764707a4a573b35df47051";

        bytes memory mergedAppendix = mergeBytes(
            CALLDATA_DELIMITER,
            transactionID
        );

        adjustedCallData = mergeBytes(callData, mergedAppendix);
    }
}
