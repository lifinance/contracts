// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { GasZipPeriphery } from "lifi/Periphery/GasZipPeriphery.sol";
import { IGnosisBridgeRouter } from "lifi/Interfaces/IGnosisBridgeRouter.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { TestGnosisBridgeFacet } from "test/solidity/Facets/GnosisBridgeFacet.t.sol";
import { IGasZip } from "lifi/Interfaces/IGasZip.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { InvalidCallData, InvalidConfig, ContractCallNotAllowed } from "lifi/Errors/GenericErrors.sol";
import { TestBase, ILiFi } from "../utils/TestBase.sol";
import { NonETHReceiver } from "../utils/TestHelpers.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Stub GenericSwapFacet Contract
contract TestGasZipPeriphery is GasZipPeriphery, TestWhitelistManagerBase {
    constructor(
        address gasZipRouter,
        address liFiDEXAggregator,
        address owner
    ) GasZipPeriphery(gasZipRouter, liFiDEXAggregator, owner) {}
}

contract GasZipPeripheryTest is TestBase {
    address public constant GAS_ZIP_ROUTER_MAINNET =
        0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762;
    address internal constant GNOSIS_BRIDGE_ROUTER =
        0x9a873656c19Efecbfb4f9FAb5B7acdeAb466a0B0;

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
        customBlockNumberForForking = 22566858;
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

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = WhitelistManagerFacet
            .setContractSelectorWhitelist
            .selector;
        functionSelectors[1] = WhitelistManagerFacet
            .isContractSelectorWhitelisted
            .selector;
        functionSelectors[2] = WhitelistManagerFacet
            .batchSetContractSelectorWhitelist
            .selector;

        addFacet(diamond, address(whitelistManagerFacet), functionSelectors);
        whitelistManagerFacet = WhitelistManagerFacet(address(diamond));

        // whitelist DEXs / Periphery contracts

        vm.label(address(uniswap), "Uniswap");
        vm.label(address(gasZipPeriphery), "GasZipPeriphery");
        vm.label(address(feeCollector), "FeeCollector");

        whitelistManagerFacet.setContractSelectorWhitelist(
            address(uniswap),
            uniswap.swapExactTokensForTokens.selector,
            true
        );
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(uniswap),
            uniswap.swapExactTokensForETH.selector,
            true
        );
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(uniswap),
            uniswap.swapETHForExactTokens.selector,
            true
        );
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(uniswap),
            uniswap.swapExactETHForTokens.selector,
            true
        );
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(gasZipPeriphery),
            gasZipPeriphery.depositToGasZipERC20.selector,
            true
        );
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(gasZipPeriphery),
            gasZipPeriphery.depositToGasZipNative.selector,
            true
        );
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(feeCollector),
            feeCollector.collectTokenFees.selector,
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

        bytes4 mockSelector = uniswap.swapExactTokensForETH.selector;
        // whitelist the mock DEX in the WhitelistManager
        vm.startPrank(USER_DIAMOND_OWNER);
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(mockDex),
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

    function testRevert_WillFailIfContractSelectorIsNotWhitelisted() public {
        vm.startPrank(USER_SENDER);

        // set DAI approval for GasZipPeriphery
        dai.approve(address(gasZipPeriphery), type(uint256).max);
        deal(ADDRESS_DAI, USER_SENDER, 1e18);

        uint256 gasZipERC20Amount = 1e18;

        // Create SwapData with a contract/selector that is NOT whitelisted
        // Using uniswap but with a non-whitelisted selector
        bytes4 nonWhitelistedSelector = bytes4(0x12345678); // arbitrary non-whitelisted selector

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(uniswap), // callTo - uniswap is whitelisted but with different selectors
            address(uniswap),
            ADDRESS_DAI,
            address(0), // receivingAssetId - native to pass the initial check
            gasZipERC20Amount,
            abi.encodeWithSelector(
                nonWhitelistedSelector, // non-whitelisted selector
                1e18,
                0,
                new address[](0),
                address(0),
                0
            ),
            true
        );

        vm.expectRevert(ContractCallNotAllowed.selector);
        gasZipPeriphery.depositToGasZipERC20(swapData, defaultGasZipData);
    }

    function testRevert_WillFailIfContractIsNotWhitelisted() public {
        vm.startPrank(USER_SENDER);

        // set DAI approval for GasZipPeriphery
        dai.approve(address(gasZipPeriphery), type(uint256).max);
        deal(ADDRESS_DAI, USER_SENDER, 1e18);

        uint256 gasZipERC20Amount = 1e18;

        // Create SwapData with a contract that is completely NOT whitelisted
        // Deploy a mock contract that is not whitelisted
        address nonWhitelistedContract = address(
            0x1234567890123456789012345678901234567890
        );

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            nonWhitelistedContract, // callTo - contract not whitelisted
            nonWhitelistedContract,
            ADDRESS_DAI,
            address(0), // receivingAssetId - native to pass the initial check
            gasZipERC20Amount,
            abi.encodeWithSelector(
                uniswap.swapExactTokensForETH.selector, // selector doesn't matter if contract isn't whitelisted
                1e18,
                0,
                new address[](0),
                address(0),
                0
            ),
            true
        );

        vm.expectRevert(ContractCallNotAllowed.selector);
        gasZipPeriphery.depositToGasZipERC20(swapData, defaultGasZipData);
    }

    function test_CanDepositERC20WhenApproveToIsDifferentFromCallTo() public {
        // Test case: approveTo != callTo, both properly whitelisted
        // This simulates DEXs where the token spender and router are different contracts

        // Use a simple address for token spender (give it code so it passes contract check)
        address tokenSpender = address(0xbeef);
        // Give the address bytecode so it passes the contract check (minimum 24 bytes required)
        vm.etch(
            tokenSpender,
            hex"600180808080800180808080800180808080800180808080801b"
        );
        MockDexRouterWithSeparateSpender dexRouter = new MockDexRouterWithSeparateSpender();

        // Fund the router with native tokens to simulate swap output
        deal(address(dexRouter), 1 ether);

        // Whitelist the router with swap selector
        vm.startPrank(USER_DIAMOND_OWNER);
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(dexRouter),
            dexRouter.swapExactTokensForETH.selector,
            true
        );

        // Whitelist the token spender with APPROVE_TO_ONLY_SELECTOR
        bytes4 approveToOnlySelector = bytes4(0xffffffff);
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(tokenSpender),
            approveToOnlySelector,
            true
        );
        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        // Prepare swap data where approveTo != callTo
        uint256 daiAmount = 1e18;
        deal(ADDRESS_DAI, USER_SENDER, daiAmount);
        dai.approve(address(gasZipPeriphery), daiAmount);

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 expectedOutput = 1e16; // 0.01 ETH

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(dexRouter), // callTo - the router contract
            tokenSpender, // approveTo - different from callTo
            ADDRESS_DAI,
            address(0), // receivingAssetId - native
            daiAmount,
            abi.encodeWithSelector(
                dexRouter.swapExactTokensForETH.selector,
                daiAmount,
                expectedOutput,
                path,
                address(gasZipPeriphery),
                block.timestamp + 20 minutes
            ),
            true
        );

        // Set up expected event for GasZip deposit
        vm.expectEmit(true, true, true, true, GAS_ZIP_ROUTER_MAINNET);
        emit Deposit(
            address(gasZipPeriphery),
            defaultDestinationChains,
            expectedOutput,
            defaultReceiverBytes32
        );

        // Execute the swap and deposit
        gasZipPeriphery.depositToGasZipERC20(swapData, defaultGasZipData);

        vm.stopPrank();
    }

    function testRevert_WillFailWhenApproveToIsNotWhitelistedWithApproveToOnlySelector()
        public
    {
        // Test case: approveTo != callTo, but approveTo is NOT whitelisted with APPROVE_TO_ONLY_SELECTOR

        // Use a simple address for token spender (no need to give it code since we're not whitelisting it)
        address tokenSpender = address(0xdead);
        MockDexRouterWithSeparateSpender dexRouter = new MockDexRouterWithSeparateSpender();

        // Whitelist the router with swap selector
        vm.startPrank(USER_DIAMOND_OWNER);
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(dexRouter),
            dexRouter.swapExactTokensForETH.selector,
            true
        );
        // Intentionally NOT whitelisting tokenSpender with APPROVE_TO_ONLY_SELECTOR
        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        // Prepare swap data where approveTo != callTo
        uint256 daiAmount = 1e18;
        deal(ADDRESS_DAI, USER_SENDER, daiAmount);
        dai.approve(address(gasZipPeriphery), daiAmount);

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(dexRouter), // callTo - whitelisted
            tokenSpender, // approveTo - NOT whitelisted with APPROVE_TO_ONLY_SELECTOR
            ADDRESS_DAI,
            address(0), // receivingAssetId - native
            daiAmount,
            abi.encodeWithSelector(
                dexRouter.swapExactTokensForETH.selector,
                daiAmount,
                0,
                path,
                address(gasZipPeriphery),
                block.timestamp + 20 minutes
            ),
            true
        );

        // Should revert because approveTo is not whitelisted
        vm.expectRevert(ContractCallNotAllowed.selector);
        gasZipPeriphery.depositToGasZipERC20(swapData, defaultGasZipData);

        vm.stopPrank();
    }

    function testRevert_WillFailWhenCallToIsNotWhitelistedEvenIfApproveToIs()
        public
    {
        // Test case: approveTo != callTo, approveTo is whitelisted, but callTo is NOT whitelisted

        // Use a simple address for token spender (give it code so it passes contract check)
        address tokenSpender = address(0xfeed);
        // Give the address bytecode so it passes the contract check (minimum 24 bytes required)
        vm.etch(
            tokenSpender,
            hex"600180808080800180808080800180808080800180808080801b"
        );
        MockDexRouterWithSeparateSpender dexRouter = new MockDexRouterWithSeparateSpender();

        // Whitelist only the token spender with APPROVE_TO_ONLY_SELECTOR
        // Intentionally NOT whitelisting the router
        vm.startPrank(USER_DIAMOND_OWNER);
        bytes4 approveToOnlySelector = bytes4(0xffffffff);
        whitelistManagerFacet.setContractSelectorWhitelist(
            address(tokenSpender),
            approveToOnlySelector,
            true
        );
        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        // Prepare swap data where approveTo != callTo
        uint256 daiAmount = 1e18;
        deal(ADDRESS_DAI, USER_SENDER, daiAmount);
        dai.approve(address(gasZipPeriphery), daiAmount);

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        LibSwap.SwapData memory swapData = LibSwap.SwapData(
            address(dexRouter), // callTo - NOT whitelisted
            tokenSpender, // approveTo - whitelisted with APPROVE_TO_ONLY_SELECTOR
            ADDRESS_DAI,
            address(0), // receivingAssetId - native
            daiAmount,
            abi.encodeWithSelector(
                dexRouter.swapExactTokensForETH.selector,
                daiAmount,
                0,
                path,
                address(gasZipPeriphery),
                block.timestamp + 20 minutes
            ),
            true
        );

        // Should revert because callTo is not whitelisted (first check fails)
        vm.expectRevert(ContractCallNotAllowed.selector);
        gasZipPeriphery.depositToGasZipERC20(swapData, defaultGasZipData);

        vm.stopPrank();
    }

    function _getGnosisBridgeFacet()
        internal
        returns (TestGnosisBridgeFacet _gnosisBridgeFacet)
    {
        _gnosisBridgeFacet = new TestGnosisBridgeFacet(
            IGnosisBridgeRouter(GNOSIS_BRIDGE_ROUTER)
        );

        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = _gnosisBridgeFacet
            .startBridgeTokensViaGnosisBridge
            .selector;
        functionSelectors[1] = _gnosisBridgeFacet
            .swapAndStartBridgeTokensViaGnosisBridge
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

contract MockDexRouterWithSeparateSpender {
    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        // This is a simplified mock that just returns native tokens
        // In reality, the router would use the tokenSpender to pull ERC20 tokens
        // and convert them to native. For testing purposes, we focus on testing
        // the whitelist check logic, not the actual swap mechanics.

        // Transfer native tokens to simulate swap output
        // The router should be funded with native tokens before the test
        to.call{ value: amountOutMin }("");

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = amountOutMin;
    }

    receive() external payable {}
}
