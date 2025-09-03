// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { GasZipPeriphery } from "lifi/Periphery/GasZipPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { TestGnosisBridgeFacet } from "test/solidity/Facets/GnosisBridgeFacet.t.sol";
import { TestBase, ILiFi } from "../utils/TestBase.sol";
import { IGnosisBridgeRouter } from "lifi/Interfaces/IGnosisBridgeRouter.sol";
import { IGasZip } from "lifi/Interfaces/IGasZip.sol";
import { NonETHReceiver } from "../utils/TestHelpers.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { LiFiDEXAggregatorDiamondTest } from "../utils/LiFiDEXAggregatorDiamondTest.sol";
import { CoreRouteFacet } from "lifi/Periphery/LDA/Facets/CoreRouteFacet.sol";
import { UniV2StyleFacet } from "lifi/Periphery/LDA/Facets/UniV2StyleFacet.sol";
import { NativeWrapperFacet } from "lifi/Periphery/LDA/Facets/NativeWrapperFacet.sol";

// Stub GenericSwapFacet Contract
contract TestGasZipPeriphery is GasZipPeriphery {
    constructor(
        address gasZipRouter,
        address liFiDEXAggregator,
        address owner
    ) GasZipPeriphery(gasZipRouter, liFiDEXAggregator, owner) {}

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

contract GasZipPeripheryTest is TestBase {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762;
    address internal constant GNOSIS_BRIDGE_ROUTER =
        0x9a873656c19Efecbfb4f9FAb5B7acdeAb466a0B0;
    address internal constant UNIV2_PAIR_DAI_WETH =
        0xA478c2975Ab1Ea89e8196811F51A7B7Ade33eB11;

    TestGnosisBridgeFacet internal gnosisBridgeFacet;
    TestGasZipPeriphery internal gasZipPeriphery;
    IGasZip.GasZipData internal defaultGasZipData;
    bytes32 internal defaultReceiverBytes32 =
        bytes32(uint256(uint160(USER_RECEIVER)));
    uint256 internal defaultNativeDepositAmount = 1e16;

    uint256 public defaultDestinationChains = 96;

    event Deposit(address from, uint256 chains, uint256 amount, bytes32 to);

    error TooManyChainIds();
    error ETHTransferFailed();

    function setUp() public override {
        customBlockNumberForForking = 22566858;
        initTestBase();
        LiFiDEXAggregatorDiamondTest.setUp();

        // deploy contracts
        gasZipPeriphery = new TestGasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            address(ldaDiamond),
            USER_DIAMOND_OWNER
        );
        defaultUSDCAmount = 10 * 10 ** usdc.decimals(); // 10 USDC

        // set up diamond with GnosisBridgeFacet so we have a bridge to test with
        gnosisBridgeFacet = _getGnosisBridgeFacet();
        _wireLDARouteFacets();

        defaultGasZipData = IGasZip.GasZipData({
            receiverAddress: defaultReceiverBytes32,
            destinationChains: defaultDestinationChains
        });

        bridgeData.bridge = "gnosis";
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = defaultDAIAmount;
        bridgeData.destinationChainId = 100;

        vm.label(address(gasZipPeriphery), "GasZipPeriphery");
        vm.label(address(ldaDiamond), "LiFiDEXAggregator");
    }

    function test_WillStoreConstructorParametersCorrectly() public {
        gasZipPeriphery = new TestGasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            address(ldaDiamond),
            USER_DIAMOND_OWNER
        );

        assertEq(
            address(gasZipPeriphery.gasZipRouter()),
            GAS_ZIP_ROUTER_MAINNET
        );
        assertEq(gasZipPeriphery.liFiDEXAggregator(), address(ldaDiamond));
    }

    function test_CanDepositNative() public {
        // set up expected event
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZipPeriphery),
            defaultDestinationChains,
            defaultNativeDepositAmount,
            defaultReceiverBytes32
        );

        // deposit via GasZip periphery contract
        gasZipPeriphery.depositToGasZipNative{
            value: defaultNativeDepositAmount
        }(defaultGasZipData, defaultNativeDepositAmount);
    }

    function test_WillReturnAnyExcessNativeValueAfterDeposit() public {
        vm.startPrank(USER_SENDER);
        uint256 balanceBefore = USER_SENDER.balance;
        // set up expected event
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZipPeriphery),
            defaultDestinationChains,
            defaultNativeDepositAmount,
            defaultReceiverBytes32
        );

        // deposit via GasZip periphery contract
        gasZipPeriphery.depositToGasZipNative{
            value: defaultNativeDepositAmount * 5
        }(defaultGasZipData, defaultNativeDepositAmount); // sending 5 times the amount, expecting 4 times to be refunded
        uint256 balanceAfter = USER_SENDER.balance;
        assertEq(balanceBefore - defaultNativeDepositAmount, balanceAfter);
    }

    function testRevert_WillFailIfRemainingNativeCannotBeReturned() public {
        // deploy contract that cannot receive ETH
        NonETHReceiver nonETHReceiver = new NonETHReceiver();

        deal(address(nonETHReceiver), 1 ether);

        vm.startPrank(address(nonETHReceiver));

        // set up expected event
        vm.expectRevert(ETHTransferFailed.selector);

        // deposit via GasZip periphery contract
        gasZipPeriphery.depositToGasZipNative{
            value: defaultNativeDepositAmount * 2
        }(defaultGasZipData, defaultNativeDepositAmount); // send twice the nativeAmount that is being deposited to trigger a refund
    }

    function test_canCollectERC20FeesThenSwapToERC20ThenDepositThenBridge()
        public
    {
        // Testcase:
        // 1. pay 1 USDC fee to FeeCollector in USDC
        // 2. swap remaining (9) USDC to DAI
        // 3. deposit 2 DAI to gasZip
        // 4. bridge remaining DAI to Gnosis using GnosisBridgeFacet

        deal(ADDRESS_USDC, address(this), defaultUSDCAmount);

        // get swapData for feeCollection
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](3);
        uint256 feeCollectionAmount = 1 * 10 ** usdc.decimals(); // 1 USD

        swapData[0] = LibSwap.SwapData(
            address(feeCollector),
            address(feeCollector),
            ADDRESS_USDC,
            ADDRESS_USDC,
            defaultUSDCAmount,
            abi.encodeWithSelector(
                feeCollector.collectTokenFees.selector,
                ADDRESS_USDC,
                feeCollectionAmount,
                0,
                address(this)
            ),
            true
        );

        // get swapData for USDC to DAI swap
        uint256 swapInputAmount = defaultUSDCAmount - feeCollectionAmount;
        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_DAI;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(
            swapInputAmount,
            path
        );
        uint256 swapOutputAmount = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC,
            ADDRESS_DAI,
            swapInputAmount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                swapInputAmount,
                swapOutputAmount,
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            false // not required since tokens are already in diamond
        );

        // // get swapData for gas zip
        uint256 gasZipERC20Amount = 2 * 10 ** dai.decimals();
        LibSwap.SwapData
            memory gasZipSwapData = _getLiFiDEXAggregatorCalldataForERC20ToNativeSwap(
                ADDRESS_DAI,
                gasZipERC20Amount,
                0, // minAmountOut
                UNIV2_PAIR_DAI_WETH,
                true,
                3000,
                ADDRESS_WRAPPED_NATIVE
            );

        swapData[2] = LibSwap.SwapData(
            address(gasZipPeriphery),
            address(gasZipPeriphery),
            ADDRESS_DAI,
            ADDRESS_DAI,
            gasZipERC20Amount,
            abi.encodeWithSelector(
                gasZipPeriphery.depositToGasZipERC20.selector,
                gasZipSwapData,
                defaultGasZipData
            ),
            false // not required since tokens are already in the diamond
        );

        // get BridgeData
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "GnosisBridge",
            integrator: "",
            referrer: address(0),
            sendingAssetId: ADDRESS_DAI,
            receiver: USER_RECEIVER,
            minAmount: swapOutputAmount - gasZipERC20Amount,
            destinationChainId: 100,
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // whitelist gasZipPeriphery and FeeCollector
        gasZipPeriphery.addDex(address(gasZipPeriphery));
        gasZipPeriphery.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipERC20.selector
        );
        gasZipPeriphery.addDex(address(feeCollector));
        gasZipPeriphery.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );

        // set approval for bridging
        usdc.approve(address(gnosisBridgeFacet), defaultUSDCAmount);

        gnosisBridgeFacet.swapAndStartBridgeTokensViaGnosisBridge(
            bridgeData,
            swapData
        );
    }

    function test_canDepositNativeThenSwapThenBridge() public {
        // Testcase:
        // 1. deposit small native amount to gasZip
        // 2. swap remaining native to DAI
        // 3. bridge remaining DAI to Gnosis using GnosisBridgeFacet

        uint256 nativeFromAmount = 1 ether;

        vm.deal(address(this), nativeFromAmount);

        uint256 nativeZipAmount = 1e14;

        // get swapData for gas zip
        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](2);
        swapData[0] = LibSwap.SwapData(
            address(gasZipPeriphery),
            address(gasZipPeriphery),
            address(0),
            address(0),
            nativeZipAmount,
            abi.encodeWithSelector(
                gasZipPeriphery.depositToGasZipNative.selector,
                defaultGasZipData,
                nativeZipAmount
            ),
            false
        );

        // get swapData for swap
        uint256 swapInputAmount = nativeFromAmount - nativeZipAmount;

        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WRAPPED_NATIVE;
        path[1] = ADDRESS_DAI;

        // Calculate expected amountOut
        uint256[] memory amounts = uniswap.getAmountsOut(
            swapInputAmount,
            path
        );
        uint256 swapOutputAmount = amounts[1];

        swapData[1] = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            address(0),
            ADDRESS_DAI,
            swapInputAmount,
            abi.encodeWithSelector(
                uniswap.swapExactETHForTokens.selector,
                swapOutputAmount,
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            false // not required since tokens are already in diamond
        );

        // get BridgeData
        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "GnosisBridge",
            integrator: "",
            referrer: address(0),
            sendingAssetId: ADDRESS_DAI,
            receiver: USER_RECEIVER,
            minAmount: swapOutputAmount,
            destinationChainId: 100,
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        // whitelist gasZipPeriphery and FeeCollector
        gasZipPeriphery.addDex(address(gasZipPeriphery));
        gasZipPeriphery.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipNative.selector
        );

        gnosisBridgeFacet.swapAndStartBridgeTokensViaGnosisBridge{
            value: nativeFromAmount
        }(bridgeData, swapData);
    }

    function test_getDestinationChainsValueReturnsCorrectValues() public {
        // case 1
        uint8[] memory chainIds = new uint8[](1);
        chainIds[0] = 17; // Polygon

        assertEq(gasZipPeriphery.getDestinationChainsValue(chainIds), 17);

        // case 2
        chainIds = new uint8[](2);
        chainIds[0] = 51;
        chainIds[1] = 52;

        assertEq(gasZipPeriphery.getDestinationChainsValue(chainIds), 13108);

        // case 3
        chainIds = new uint8[](5);
        chainIds[0] = 15; // Avalanche
        chainIds[1] = 54; // Base
        chainIds[2] = 96; // Blast
        chainIds[3] = 14; // BSC
        chainIds[4] = 59; // Linea

        assertEq(
            gasZipPeriphery.getDestinationChainsValue(chainIds),
            65336774203
        );
    }

    function testRevert_WillFailIfSwapViaLiFiDEXAggregatorIsUnsuccessful()
        public
    {
        vm.startPrank(USER_SENDER);

        // set DAI approval for GasZipPeriphery
        dai.approve(address(gasZipPeriphery), type(uint256).max);

        // // get swapData for gas zip
        uint256 gasZipERC20Amount = 2 * 10 ** dai.decimals();
        LibSwap.SwapData
            memory gasZipSwapData = _getLiFiDEXAggregatorCalldataForERC20ToNativeSwap(
                ADDRESS_DAI,
                gasZipERC20Amount,
                0, // minAmountOut
                UNIV2_PAIR_DAI_WETH,
                true,
                3000,
                ADDRESS_WRAPPED_NATIVE
            );

        // use an invalid function selector to force the call to LiFiDEXAggregator to fail
        gasZipSwapData.callData = hex"3a3f7332";

        // expect the following call to fail without an error reason
        vm.expectRevert();

        // execute the call
        gasZipPeriphery.depositToGasZipERC20(
            gasZipSwapData,
            defaultGasZipData
        );
    }

    function testRevert_WillFailIfMoreThan32ChainIds() public {
        vm.startPrank(USER_SENDER);

        uint8[] memory chainIds = new uint8[](33);

        vm.expectRevert(TooManyChainIds.selector);

        gasZipPeriphery.getDestinationChainsValue(chainIds);
    }

    function testRevert_WillFailIfCalledWithInvalidReceiverAddress() public {
        vm.startPrank(USER_SENDER);

        defaultGasZipData.receiverAddress = bytes32(0);

        vm.expectRevert(InvalidCallData.selector);

        // deposit via GasZip periphery contract
        gasZipPeriphery.depositToGasZipNative{
            value: defaultNativeDepositAmount
        }(defaultGasZipData, defaultNativeDepositAmount);
    }

    function _getGnosisBridgeFacet()
        internal
        returns (TestGnosisBridgeFacet _gnosisBridgeFacet)
    {
        _gnosisBridgeFacet = new TestGnosisBridgeFacet(
            IGnosisBridgeRouter(GNOSIS_BRIDGE_ROUTER)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = _gnosisBridgeFacet
            .startBridgeTokensViaGnosisBridge
            .selector;
        functionSelectors[1] = _gnosisBridgeFacet
            .swapAndStartBridgeTokensViaGnosisBridge
            .selector;
        functionSelectors[2] = _gnosisBridgeFacet.addDex.selector;
        functionSelectors[3] = _gnosisBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(
            address(diamond),
            address(_gnosisBridgeFacet),
            functionSelectors
        );

        _gnosisBridgeFacet = TestGnosisBridgeFacet(address(diamond));

        // whitelist DEXs / Periphery contracts
        _gnosisBridgeFacet.addDex(address(uniswap));
        _gnosisBridgeFacet.addDex(address(gasZipPeriphery));
        _gnosisBridgeFacet.addDex(address(feeCollector));

        // add function selectors for GasZipPeriphery
        _gnosisBridgeFacet.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipERC20.selector
        );
        _gnosisBridgeFacet.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipNative.selector
        );

        // add function selectors for FeeCollector
        _gnosisBridgeFacet.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );

        // add function selectors for Uniswap
        _gnosisBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        _gnosisBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector
        );
        _gnosisBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        _gnosisBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector
        );

        setFacetAddressInTestBase(address(gnosisBridgeFacet), "GnosisFacet");
    }

    function _wireLDARouteFacets() internal {
        bytes4[] memory selectors;

        CoreRouteFacet core = new CoreRouteFacet();
        selectors = new bytes4[](1);
        selectors[0] = CoreRouteFacet.processRoute.selector;
        addFacet(address(ldaDiamond), address(core), selectors);

        UniV2StyleFacet uni = new UniV2StyleFacet();
        selectors = new bytes4[](1);
        selectors[0] = UniV2StyleFacet.swapUniV2.selector;
        addFacet(address(ldaDiamond), address(uni), selectors);

        NativeWrapperFacet wrap = new NativeWrapperFacet();
        selectors = new bytes4[](1);
        selectors[0] = NativeWrapperFacet.unwrapNative.selector;
        addFacet(address(ldaDiamond), address(wrap), selectors);
    }

    // Break into smaller functions to reduce stack variables
    function _buildSelectorRoute_ERC20ToNative(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        address uniV2Pool,
        bool token0ToToken1,
        uint24 fee,
        address wrappedNative
    ) private view returns (bytes memory) {
        // Build legs first
        (
            bytes memory uniV2LegWithLen,
            bytes memory unwrapLegWithLen
        ) = _buildLegs(uniV2Pool, token0ToToken1, fee);

        // Pack route data
        return
            _packRouteData(
                tokenIn,
                amountIn,
                minAmountOut,
                uniV2LegWithLen,
                unwrapLegWithLen,
                wrappedNative
            );
    }

    function _buildLegs(
        address uniV2Pool,
        bool token0ToToken1,
        uint24 fee
    )
        private
        view
        returns (bytes memory uniV2LegWithLen, bytes memory unwrapLegWithLen)
    {
        // Build UniV2 leg
        bytes memory uniV2Payload = abi.encodePacked(
            uniV2Pool,
            token0ToToken1 ? uint8(1) : uint8(0),
            address(ldaDiamond),
            fee
        );
        bytes memory uniV2Leg = abi.encodePacked(
            UniV2StyleFacet.swapUniV2.selector,
            uniV2Payload
        );
        uniV2LegWithLen = abi.encodePacked(uint16(uniV2Leg.length), uniV2Leg);

        // Build unwrap leg
        bytes memory unwrapPayload = abi.encodePacked(
            address(gasZipPeriphery)
        );
        bytes memory unwrapLeg = abi.encodePacked(
            NativeWrapperFacet.unwrapNative.selector,
            unwrapPayload
        );
        unwrapLegWithLen = abi.encodePacked(
            uint16(unwrapLeg.length),
            unwrapLeg
        );
    }

    function _packRouteData(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes memory uniV2LegWithLen,
        bytes memory unwrapLegWithLen,
        address wrappedNative
    ) private view returns (bytes memory) {
        // Command 2: DistributeUserERC20 (DAI from GasZipPeriphery) → UniV2 leg sends WETH to diamond
        bytes memory route = abi.encodePacked(
            uint8(2), // DistributeUserERC20
            tokenIn, // token = DAI
            uint8(1), // n = 1 leg
            uint16(type(uint16).max), // share
            uniV2LegWithLen // [len][selector|payload]
        );
        // Command 1: DistributeSelfERC20 (WETH now on diamond) → unwrap to GasZipPeriphery
        route = abi.encodePacked(
            route,
            uint8(1), // DistributeSelfERC20
            wrappedNative, // token = WETH
            uint8(1), // n = 1 leg
            uint16(type(uint16).max), // share
            unwrapLegWithLen // [len][selector|payload]
        );

        return
            abi.encodeWithSelector(
                CoreRouteFacet.processRoute.selector,
                tokenIn,
                amountIn,
                address(0), // tokenOut = native
                minAmountOut,
                address(gasZipPeriphery), // receiver (native)
                route // bytes route
            );
    }

    function _getLiFiDEXAggregatorCalldataForERC20ToNativeSwap(
        address tokenIn,
        uint256 amountIn,
        uint256 minAmountOut,
        // params you already know in your test env
        address uniV2Pool,
        bool token0ToToken1,
        uint24 fee,
        address wrappedNative
    ) internal view returns (LibSwap.SwapData memory) {
        bytes memory routeCall = _buildSelectorRoute_ERC20ToNative(
            tokenIn,
            amountIn,
            minAmountOut,
            uniV2Pool,
            token0ToToken1,
            fee,
            wrappedNative
        );

        return
            LibSwap.SwapData({
                callTo: address(ldaDiamond), // LiFiDEXAggregator diamond address (CoreRouteFacet lives here)
                approveTo: address(ldaDiamond),
                sendingAssetId: tokenIn,
                receivingAssetId: address(0), // native
                fromAmount: amountIn,
                callData: routeCall,
                requiresDeposit: true
            });
    }
}
