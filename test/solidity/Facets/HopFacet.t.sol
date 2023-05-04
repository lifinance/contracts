// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBaseFacet, console, ERC20 } from "../utils/TestBaseFacet.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, AlreadyInitialized, InvalidAmount } from "src/Errors/GenericErrors.sol";
import { DiamondTest, LiFiDiamond } from "../utils/DiamondTest.sol";

// Stub HopFacet Contract
contract TestHopFacet is HopFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetTest is TestBaseFacet {
    // EVENTS
    event HopBridgeRegistered(address indexed assetId, address bridge);
    event HopInitialized(HopFacet.Config[] configs);

    // These values are for Mainnet
    address internal constant USDC_BRIDGE =
        0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant DAI_BRIDGE =
        0x3d4Cc8A61c7528Fd86C55cfe061a78dCBA48EDd1;
    address internal constant NATIVE_BRIDGE =
        0xb8901acB165ed027E32754E0FFe830802919727f;
    uint256 internal constant DSTCHAIN_ID = 137;
    // -----

    TestHopFacet internal hopFacet;
    ILiFi.BridgeData internal validBridgeData;
    HopFacet.HopData internal validHopData;

    function setUp() public {
        initTestBase();
        hopFacet = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = hopFacet.startBridgeTokensViaHop.selector;
        functionSelectors[1] = hopFacet
            .swapAndStartBridgeTokensViaHop
            .selector;
        functionSelectors[2] = hopFacet.initHop.selector;
        functionSelectors[3] = hopFacet.registerBridge.selector;
        functionSelectors[4] = hopFacet.addDex.selector;
        functionSelectors[5] = hopFacet
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        HopFacet.Config[] memory configs = new HopFacet.Config[](3);
        configs[0] = HopFacet.Config(ADDRESS_USDC, USDC_BRIDGE);
        configs[1] = HopFacet.Config(ADDRESS_DAI, DAI_BRIDGE);
        configs[2] = HopFacet.Config(address(0), NATIVE_BRIDGE);

        hopFacet = TestHopFacet(address(diamond));
        hopFacet.initHop(configs);

        hopFacet.addDex(address(uniswap));
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        hopFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );
        setFacetAddressInTestBase(address(hopFacet), "HopFacet");

        vm.makePersistent(address(hopFacet));

        // adjust bridgeData
        bridgeData.bridge = "hop";
        bridgeData.destinationChainId = DSTCHAIN_ID;

        // produce valid HopData
        validHopData = HopFacet.HopData({
            bonderFee: 0,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            relayer: address(0),
            relayerFee: 0,
            nativeFee: 0
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hopFacet.startBridgeTokensViaHop{ value: bridgeData.minAmount }(
                bridgeData,
                validHopData
            );
        } else {
            hopFacet.startBridgeTokensViaHop(bridgeData, validHopData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            hopFacet.swapAndStartBridgeTokensViaHop{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validHopData);
        } else {
            hopFacet.swapAndStartBridgeTokensViaHop(
                bridgeData,
                swapData,
                validHopData
            );
        }
    }

    function testRevert_ReentrantCallBridge() public {
        vm.startPrank(USER_SENDER);

        // prepare bridge data for native bridging
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(
                hopFacet.startBridgeTokensViaHop.selector,
                bridgeData,
                validHopData
            )
        );
        vm.stopPrank();
    }

    function testRevert_ReentrantCallBridgeAndSwap() public {
        vm.startPrank(USER_SENDER);

        // prepare bridge data for native bridging
        setDefaultBridgeData();
        bridgeData.hasSourceSwaps = true;

        setDefaultSwapDataSingleDAItoUSDC();
        address[] memory path = new address[](2);
        path[0] = ADDRESS_WETH;
        path[1] = ADDRESS_USDC;

        uint256 amountOut = defaultUSDCAmount;

        // Calculate DAI amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: address(0),
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapETHForExactTokens.selector,
                    amountOut,
                    path,
                    address(hopFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(
                hopFacet.swapAndStartBridgeTokensViaHop.selector,
                bridgeData,
                swapData,
                validHopData
            )
        );
    }

    function testRevert_NotEnoughMsgValue() public {
        vm.startPrank(USER_USDC_WHALE);
        // prepare bridgeData
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.expectRevert(InvalidAmount.selector);

        hopFacet.startBridgeTokensViaHop{ value: bridgeData.minAmount - 1 }(
            bridgeData,
            validHopData
        );

        vm.stopPrank();
    }

    function test_canRegisterNewBridgeAddresses() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(hopFacet));
        emit HopBridgeRegistered(ADDRESS_USDC, NATIVE_BRIDGE);

        hopFacet.registerBridge(ADDRESS_USDC, NATIVE_BRIDGE);
    }

    function testRevert_RegisterBridgeNonOwner() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        hopFacet.registerBridge(ADDRESS_USDC, NATIVE_BRIDGE);
    }

    function testRevert_RegisterBridgeWithInvalidAddress() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        vm.expectRevert(InvalidConfig.selector);
        hopFacet.registerBridge(ADDRESS_USDC, address(0));
        vm.stopPrank();
    }

    function test_OwnerCanInitializeFacet() public {
        vm.startPrank(USER_DIAMOND_OWNER);
        LiFiDiamond diamond2 = createDiamond();

        TestHopFacet hopFacet2 = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = hopFacet2.startBridgeTokensViaHop.selector;
        functionSelectors[1] = hopFacet2
            .swapAndStartBridgeTokensViaHop
            .selector;
        functionSelectors[2] = hopFacet2.initHop.selector;
        functionSelectors[3] = hopFacet2.registerBridge.selector;
        functionSelectors[4] = hopFacet2.addDex.selector;
        functionSelectors[5] = hopFacet2
            .setFunctionApprovalBySignature
            .selector;

        addFacet(diamond2, address(hopFacet2), functionSelectors);

        HopFacet.Config[] memory configs = new HopFacet.Config[](3);
        configs[0] = HopFacet.Config(ADDRESS_USDC, USDC_BRIDGE);
        configs[1] = HopFacet.Config(ADDRESS_DAI, DAI_BRIDGE);
        configs[2] = HopFacet.Config(address(0), NATIVE_BRIDGE);

        hopFacet2 = TestHopFacet(address(diamond2));

        vm.expectEmit(true, true, true, true, address(hopFacet2));
        emit HopInitialized(configs);
        hopFacet2.initHop(configs);
    }

    function test_BridgeFromL2ToL1() public {
        address AMM_WRAPPER_POLYGON = 0x76b22b8C1079A44F1211D867D68b1eda76a635A7;
        address ADDRESS_USDC_POLYGON = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;
        address USER_USDC_WHALE_POLYGON = 0x1a13F4Ca1d028320A707D99520AbFefca3998b7F; //USDC Whale Polygon

        // create polygon fork
        string memory rpcUrl = vm.envString("ETH_NODE_URI_POLYGON");
        uint256 blockNumber = 36004499;
        vm.createSelectFork(rpcUrl, blockNumber);

        // get USDC contract and approve
        ERC20 usdcPoly = ERC20(ADDRESS_USDC_POLYGON); // USDC on Polygon

        // re-deploy diamond and facet
        diamond = createDiamond();
        TestHopFacet hopFacet2 = new TestHopFacet();
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = hopFacet2.startBridgeTokensViaHop.selector;
        functionSelectors[2] = hopFacet2.initHop.selector;
        functionSelectors[3] = hopFacet2.registerBridge.selector;

        addFacet(diamond, address(hopFacet2), functionSelectors);

        HopFacet.Config[] memory configs = new HopFacet.Config[](1);
        configs[0] = HopFacet.Config(
            ADDRESS_USDC_POLYGON,
            AMM_WRAPPER_POLYGON
        );

        hopFacet2 = TestHopFacet(address(diamond));
        hopFacet2.initHop(configs);

        // adjust bridgeData
        bridgeData.destinationChainId = 1;
        bridgeData.sendingAssetId = ADDRESS_USDC_POLYGON;

        // produce valid HopData
        validHopData = HopFacet.HopData({
            bonderFee: 10000000,
            amountOutMin: 0,
            deadline: block.timestamp + 60 * 20,
            destinationAmountOutMin: 0,
            destinationDeadline: block.timestamp + 60 * 20,
            relayer: address(0),
            relayerFee: 0,
            nativeFee: 0
        });

        // activate token whale account and approve USDC
        vm.startPrank(USER_USDC_WHALE_POLYGON);
        usdcPoly.approve(address(hopFacet2), defaultUSDCAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(hopFacet2));
        emit LiFiTransferStarted(bridgeData);

        hopFacet2.startBridgeTokensViaHop(bridgeData, validHopData);
    }
}
