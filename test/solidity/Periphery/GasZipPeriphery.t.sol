// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { GasZipPeriphery } from "lifi/Periphery/GasZipPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { TestGnosisBridgeFacet } from "test/solidity/Facets/GnosisBridgeFacet.t.sol";
import { TestBase, ILiFi } from "../utils/TestBase.sol";
import { IXDaiBridge } from "lifi/Interfaces/IXDaiBridge.sol";
import { IGasZip } from "lifi/Interfaces/IGasZip.sol";
import { NonETHReceiver } from "../utils/TestHelpers.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

// Stub GenericSwapFacet Contract
contract TestGasZipPeriphery is GasZipPeriphery {
    constructor(
        address gasZipRouter,
        address liFiDEXAggregator,
        address owner
    ) GasZipPeriphery(gasZipRouter, liFiDEXAggregator, owner) {}

    function addToWhitelist(address _address) external {
        LibAllowList.addAllowedContract(_address);
    }

    function removeFromWhitelist(address _address) external {
        LibAllowList.removeAllowedContract(_address);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract GasZipPeripheryTest is TestBase {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762;
    address public constant LIFI_DEX_AGGREGATOR_MAINNET =
        0xe43ca1Dee3F0fc1e2df73A0745674545F11A59F5;
    address internal constant XDAI_BRIDGE =
        0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;

    TestGnosisBridgeFacet internal gnosisBridgeFacet;
    TestGasZipPeriphery internal gasZipPeriphery;
    IGasZip.GasZipData internal defaultGasZipData;
    address internal liFiDEXAggregator = LIFI_DEX_AGGREGATOR_MAINNET;
    bytes32 internal defaultReceiverBytes32 =
        bytes32(uint256(uint160(USER_RECEIVER)));
    uint256 internal defaultNativeDepositAmount = 1e16;

    uint256 public defaultDestinationChains = 96;

    event Deposit(address from, uint256 chains, uint256 amount, bytes32 to);

    error TooManyChainIds();
    error ETHTransferFailed();

    function setUp() public {
        customBlockNumberForForking = 20931877;
        initTestBase();

        // deploy contracts
        gasZipPeriphery = new TestGasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            LIFI_DEX_AGGREGATOR_MAINNET,
            USER_DIAMOND_OWNER
        );
        defaultUSDCAmount = 10 * 10 ** usdc.decimals(); // 10 USDC

        // set up diamond with GnosisBridgeFacet so we have a bridge to test with
        gnosisBridgeFacet = _getGnosisBridgeFacet();

        defaultGasZipData = IGasZip.GasZipData({
            receiverAddress: defaultReceiverBytes32,
            destinationChains: defaultDestinationChains
        });

        bridgeData.bridge = "gnosis";
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = defaultDAIAmount;
        bridgeData.destinationChainId = 100;

        vm.label(address(gasZipPeriphery), "GasZipPeriphery");
        vm.label(LIFI_DEX_AGGREGATOR_MAINNET, "LiFiDEXAggregator");
    }

    function test_WillStoreConstructorParametersCorrectly() public {
        gasZipPeriphery = new TestGasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            LIFI_DEX_AGGREGATOR_MAINNET,
            USER_DIAMOND_OWNER
        );

        assertEq(
            address(gasZipPeriphery.gasZipRouter()),
            GAS_ZIP_ROUTER_MAINNET
        );
        assertEq(
            gasZipPeriphery.liFiDEXAggregator(),
            LIFI_DEX_AGGREGATOR_MAINNET
        );
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
        (
            LibSwap.SwapData memory gasZipSwapData,

        ) = _getLiFiDEXAggregatorCalldataForERC20ToNativeSwap(
                ADDRESS_DAI,
                gasZipERC20Amount
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
        gasZipPeriphery.addToWhitelist(address(gasZipPeriphery));
        gasZipPeriphery.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipERC20.selector
        );
        gasZipPeriphery.addToWhitelist(address(feeCollector));
        gasZipPeriphery.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector
        );

        // set approval for bridging
        usdc.approve(address(gnosisBridgeFacet), defaultUSDCAmount);

        gnosisBridgeFacet.swapAndStartBridgeTokensViaXDaiBridge(
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
        gasZipPeriphery.addToWhitelist(address(gasZipPeriphery));
        gasZipPeriphery.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipNative.selector
        );

        gnosisBridgeFacet.swapAndStartBridgeTokensViaXDaiBridge{
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
        (
            LibSwap.SwapData memory gasZipSwapData,

        ) = _getLiFiDEXAggregatorCalldataForERC20ToNativeSwap(
                ADDRESS_DAI,
                gasZipERC20Amount
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
            IXDaiBridge(XDAI_BRIDGE)
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = _gnosisBridgeFacet
            .startBridgeTokensViaXDaiBridge
            .selector;
        functionSelectors[1] = _gnosisBridgeFacet
            .swapAndStartBridgeTokensViaXDaiBridge
            .selector;
        functionSelectors[2] = _gnosisBridgeFacet.addToWhitelist.selector;
        functionSelectors[3] = _gnosisBridgeFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(_gnosisBridgeFacet), functionSelectors);

        _gnosisBridgeFacet = TestGnosisBridgeFacet(address(diamond));

        // whitelist DEXs / Periphery contracts
        _gnosisBridgeFacet.addToWhitelist(address(uniswap));
        _gnosisBridgeFacet.addToWhitelist(address(gasZipPeriphery));
        _gnosisBridgeFacet.addToWhitelist(address(feeCollector));

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

    function _getLiFiDEXAggregatorCalldataForERC20ToNativeSwap(
        address sendingAssetId,
        uint256 fromAmount
    )
        internal
        view
        returns (LibSwap.SwapData memory swapData, uint256 amountOutMin)
    {
        // prepare swap data
        address[] memory path = new address[](2);
        path[0] = sendingAssetId;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsOut(fromAmount, path);
        amountOutMin = amounts[1];

        swapData = LibSwap.SwapData(
            liFiDEXAggregator,
            liFiDEXAggregator,
            sendingAssetId,
            address(0),
            fromAmount,
            // this is calldata for the DEXAggregator to swap 2 DAI to native
            hex"2646478b0000000000000000000000006b175474e89094c44da98b954eedeac495271d0f0000000000000000000000000000000000000000000000001bc16d674ec80000000000000000000000000000eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0000000000000000000000000000000000000000000000000002f70244563dc70000000000000000000000007f2922c09dd671055c5abbc4f5657f874c18062900000000000000000000000000000000000000000000000000000000000000c00000000000000000000000000000000000000000000000000000000000000073026B175474E89094C44Da98b954EedeAC495271d0F01ffff00A478c2975Ab1Ea89e8196811F51A7B7Ade33eB1101e43ca1Dee3F0fc1e2df73A0745674545F11A59F5000bb801C02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc201ffff02007F2922c09DD671055C5aBBC4F5657f874c18062900000000000000000000000000",
            true
        );
    }
}
