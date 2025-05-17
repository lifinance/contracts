// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { GasZipPeriphery } from "lifi/Periphery/GasZipPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestGnosisBridgeFacet } from "test/solidity/Facets/GnosisBridgeFacet.t.sol";
import { IXDaiBridge } from "lifi/Interfaces/IXDaiBridge.sol";
import { IGasZip } from "lifi/Interfaces/IGasZip.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { InvalidCallData, InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { TestBase, ILiFi } from "../utils/TestBase.sol";
import { NonETHReceiver } from "../utils/TestHelpers.sol";

contract GasZipPeripheryTest is TestBase {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762;
    address public constant LIFI_DEX_AGGREGATOR_MAINNET =
        0xe43ca1Dee3F0fc1e2df73A0745674545F11A59F5;
    address internal constant XDAI_BRIDGE =
        0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016;

    TestGnosisBridgeFacet internal gnosisBridgeFacet;
    GasZipPeriphery internal gasZipPeriphery;
    WhitelistManagerFacet internal whitelistManagerFacet;
    IGasZip.GasZipData internal defaultGasZipData;
    bytes32 internal defaultReceiverBytes32 =
        bytes32(uint256(uint160(USER_RECEIVER)));
    uint256 internal defaultNativeDepositAmount = 1e16;

    uint256 public defaultDestinationChains = 96;
    bytes4 internal constant PROCESS_ROUTE_SELECTOR = bytes4(hex"2646478b");

    event Deposit(address from, uint256 chains, uint256 amount, bytes32 to);

    error TooManyChainIds();
    error ETHTransferFailed();
    error SwapFailed();

    function setUp() public {
        customBlockNumberForForking = 20931877;
        initTestBase();

        // Deploy contracts and set up the Diamond with the facets
        gnosisBridgeFacet = _getGnosisBridgeFacet();

        // Deploy WhitelistManagerFacet and add it to the diamond
        whitelistManagerFacet = new WhitelistManagerFacet();

        // Deploy GasZipPeriphery with diamond from TestBase
        gasZipPeriphery = new GasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            address(diamond),
            USER_DIAMOND_OWNER
        );

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = WhitelistManagerFacet.addToWhitelist.selector;
        functionSelectors[1] = WhitelistManagerFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[2] = WhitelistManagerFacet
            .isAddressWhitelisted
            .selector;
        functionSelectors[3] = WhitelistManagerFacet
            .isFunctionApproved
            .selector;

        addFacet(diamond, address(whitelistManagerFacet), functionSelectors);
        whitelistManagerFacet = WhitelistManagerFacet(address(diamond));

        // whitelist DEXs / Periphery contracts
        whitelistManagerFacet.addToWhitelist(address(uniswap));
        whitelistManagerFacet.addToWhitelist(address(gasZipPeriphery));
        whitelistManagerFacet.addToWhitelist(address(feeCollector));

        vm.label(address(uniswap), "Uniswap");
        vm.label(address(gasZipPeriphery), "GasZipPeriphery");
        vm.label(address(feeCollector), "FeeCollector");

        // add function selectors for GasZipPeriphery
        whitelistManagerFacet.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipERC20.selector,
            true
        );
        whitelistManagerFacet.setFunctionApprovalBySignature(
            gasZipPeriphery.depositToGasZipNative.selector,
            true
        );

        // add function selectors for FeeCollector
        whitelistManagerFacet.setFunctionApprovalBySignature(
            feeCollector.collectTokenFees.selector,
            true
        );

        // add function selectors for Uniswap
        whitelistManagerFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector,
            true
        );
        whitelistManagerFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForETH.selector,
            true
        );
        whitelistManagerFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector,
            true
        );
        whitelistManagerFacet.setFunctionApprovalBySignature(
            uniswap.swapExactETHForTokens.selector,
            true
        );

        defaultUSDCAmount = 10 * 10 ** usdc.decimals(); // 10 USDC

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
        gasZipPeriphery = new GasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            address(diamond),
            USER_DIAMOND_OWNER
        );

        assertEq(
            address(gasZipPeriphery.GAS_ZIP_ROUTER()),
            GAS_ZIP_ROUTER_MAINNET
        );
        assertEq(gasZipPeriphery.LIFI_DIAMOND(), address(diamond));
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
        // 3. deposit 2 DAI to GasZipPeriphery which will be swapped to ETH and sent to the GasZip contract
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

        ) = _getUniswapERC20ToNativeSwapData(ADDRESS_DAI, gasZipERC20Amount);

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

        assertEq(gasZipPeriphery.getDestinationChainsValue(chainIds), 3342388);

        // case 3
        chainIds = new uint8[](5);
        chainIds[0] = 15; // Avalanche
        chainIds[1] = 54; // Base
        chainIds[2] = 96; // Blast
        chainIds[3] = 14; // BSC
        chainIds[4] = 59; // Linea

        assertEq(
            gasZipPeriphery.getDestinationChainsValue(chainIds),
            276716361166703427643
        );

        chainIds = new uint8[](16);
        chainIds[0] = 255; // Chain ID 255
        chainIds[1] = 57; // Chain ID 57
        chainIds[2] = 62; // Chain ID 62
        chainIds[3] = 15; // Chain ID 15
        chainIds[4] = 54; // Chain ID 54
        chainIds[5] = 96; // Chain ID 96
        chainIds[6] = 140; // Chain ID 140
        chainIds[7] = 148; // Chain ID 148
        chainIds[8] = 21; // Chain ID 21
        chainIds[9] = 20; // Chain ID 20
        chainIds[10] = 10; // Chain ID 10
        chainIds[11] = 31; // Chain ID 31
        chainIds[12] = 16; // Chain ID 16
        chainIds[13] = 59; // Chain ID 59
        chainIds[14] = 13; // Chain ID 13
        chainIds[15] = 30; // Chain ID 30

        assertEq(
            gasZipPeriphery.getDestinationChainsValue(chainIds),
            450547538260953446430386195920619374874770272090431965477324569820816801822
        );
    }

    function testRevert_WillFailIfSwapViaLiFiDEXAggregatorIsUnsuccessful()
        public
    {
        vm.startPrank(USER_SENDER);

        // set DAI approval for GasZipPeriphery
        dai.approve(address(gasZipPeriphery), type(uint256).max);

        uint256 gasZipERC20Amount = 2 * 10 ** dai.decimals();
        (
            LibSwap.SwapData memory gasZipSwapData,

        ) = _getUniswapERC20ToNativeSwapData(ADDRESS_DAI, gasZipERC20Amount);

        // use an invalid function selector to force the call to LiFiDEXAggregator to fail
        // Note: The function must pass the whitelist check but fail when executed
        gasZipSwapData.callData = abi.encodeWithSelector(
            PROCESS_ROUTE_SELECTOR,
            address(0), // invalid params to make the call fail
            0,
            address(0),
            0,
            address(0),
            ""
        );

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

    function testRevert_WillFailIfReceivingAssetIsNotNative() public {
        vm.startPrank(USER_SENDER);

        // create SwapData with non-native receiving asset (e.g., DAI instead of ETH/address(0))
        uint256 daiAmount = 1e18;

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            ADDRESS_USDC, // sending USDC
            ADDRESS_DAI, // receiving DAI (non-native) - this should cause revert
            daiAmount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForTokens.selector,
                daiAmount,
                0,
                new address[](0), // not important for this test
                address(0),
                0
            ),
            true
        );

        vm.expectRevert(GasZipPeriphery.SwapOutputMustBeNative.selector);

        // call depositToGasZipERC20 with non-native receiving asset, should revert immediately
        gasZipPeriphery.depositToGasZipERC20(swapData, defaultGasZipData);
    }

    function testRevert_WillFailWhenSwapOperationIsUnsuccessful() public {
        // deploy a simple mock contract that can be called and will revert with our custom error
        MockFailingDexWithCustomError mockDex = new MockFailingDexWithCustomError();

        // whitelist the mock DEX in the WhitelistManager
        vm.startPrank(USER_DIAMOND_OWNER);
        whitelistManagerFacet.addToWhitelist(address(mockDex));

        bytes4 mockSelector = uniswap.swapExactTokensForETH.selector;
        whitelistManagerFacet.setFunctionApprovalBySignature(
            mockSelector,
            true
        );
        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        // SwapData with the mock DEX that will fail
        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(mockDex), // callTo - the mock contract that will revert
            address(mockDex),
            ADDRESS_DAI,
            address(0), // receivingAssetId - set to native to pass the initial check
            1e18, // fromAmount
            abi.encodeWithSelector(
                mockSelector,
                1e18,
                0,
                new address[](2),
                address(0),
                0
            ),
            true
        );

        deal(ADDRESS_DAI, USER_SENDER, 1e18);

        dai.approve(address(gasZipPeriphery), 1e18);

        vm.expectRevert(SwapFailed.selector);
        gasZipPeriphery.depositToGasZipERC20(swapData, defaultGasZipData);
    }

    function testRevert_WillFailWithZeroGasZipRouter() public {
        // Try to deploy with zero address for gasZipRouter
        vm.expectRevert(InvalidConfig.selector);
        new GasZipPeriphery(
            address(0), // zero address for gasZipRouter
            address(diamond),
            USER_DIAMOND_OWNER
        );
    }

    function testRevert_WillFailWithZeroLiFiDiamond() public {
        // Try to deploy with zero address for liFiDiamond
        vm.expectRevert(InvalidConfig.selector);
        new GasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            address(0), // zero address for liFiDiamond
            USER_DIAMOND_OWNER
        );
    }

    function testRevert_WillFailWithZeroOwner() public {
        // Try to deploy with zero address for owner
        vm.expectRevert(InvalidConfig.selector);
        new GasZipPeriphery(
            GAS_ZIP_ROUTER_MAINNET,
            address(diamond),
            address(0) // zero address for owner
        );
    }

    function _getGnosisBridgeFacet()
        internal
        returns (TestGnosisBridgeFacet _gnosisBridgeFacet)
    {
        _gnosisBridgeFacet = new TestGnosisBridgeFacet(
            IXDaiBridge(XDAI_BRIDGE)
        );

        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = _gnosisBridgeFacet
            .startBridgeTokensViaXDaiBridge
            .selector;
        functionSelectors[1] = _gnosisBridgeFacet
            .swapAndStartBridgeTokensViaXDaiBridge
            .selector;

        addFacet(diamond, address(_gnosisBridgeFacet), functionSelectors);

        _gnosisBridgeFacet = TestGnosisBridgeFacet(address(diamond));

        setFacetAddressInTestBase(address(gnosisBridgeFacet), "GnosisFacet");
    }

    function _getUniswapERC20ToNativeSwapData(
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

        // Calculate expected amount out
        uint256[] memory amounts = uniswap.getAmountsOut(fromAmount, path);
        amountOutMin = amounts[1];

        // Use Uniswap directly instead of LiFiDEXAggregator
        swapData = LibSwap.SwapData(
            address(uniswap),
            address(uniswap),
            sendingAssetId,
            address(0), // receiving native ETH
            fromAmount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector, // Use swapExactTokensForETH
                fromAmount,
                amountOutMin,
                path,
                address(gasZipPeriphery), // Send ETH to GasZipPeriphery
                block.timestamp + 20 minutes
            ),
            true
        );
    }
}

contract MockFailingDexWithCustomError {
    error SwapFailed();

    function swapExactTokensForETH(
        uint256,
        uint256,
        address[] calldata,
        address,
        uint256
    ) external pure {
        revert SwapFailed();
    }

    fallback() external {
        revert SwapFailed();
    }

    receive() external payable {}
}
