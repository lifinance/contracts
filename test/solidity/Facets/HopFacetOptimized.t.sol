// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { ILiFi, LibSwap, LibAllowList, TestBase, console } from "../utils/TestBase.sol";
import { HopFacet } from "lifi/Facets/HopFacet.sol";

// Stub HopFacet Contract
contract TestHopFacet is HopFacet {
    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract HopFacetTest is TestBase {
    // These values are for Mainnet
    address internal constant USDC_ADDRESS = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDC_BRIDGE = 0x3666f603Cc164936C1b87e207F36BEBa4AC5f18a;
    address internal constant USDC_HOLDER = 0xaD0135AF20fa82E106607257143d0060A7eB5cBf;
    address internal constant DAI_ADDRESS = 0x6B175474E89094C44Da98b954EedeAC495271d0F;
    address internal constant DAI_BRIDGE = 0x3d4Cc8A61c7528Fd86C55cfe061a78dCBA48EDd1;
    address internal constant DAI_HOLDER = 0x4943b0C9959dcf58871A799dfB71becE0D97c9f4;
    address internal constant CONNEXT_HANDLER = 0xB4C1340434920d70aD774309C75f9a4B679d801e;
    address internal constant UNISWAP_V2_ROUTER = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D;
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
        functionSelectors[1] = hopFacet.swapAndStartBridgeTokensViaHop.selector;
        functionSelectors[2] = hopFacet.initHop.selector;
        functionSelectors[3] = hopFacet.registerBridge.selector;
        functionSelectors[4] = hopFacet.addDex.selector;
        functionSelectors[5] = hopFacet.setFunctionApprovalBySignature.selector;

        addFacet(diamond, address(hopFacet), functionSelectors);

        HopFacet.Config[] memory configs = new HopFacet.Config[](2);
        configs[0] = HopFacet.Config(USDC_ADDRESS, USDC_BRIDGE);
        configs[1] = HopFacet.Config(DAI_ADDRESS, DAI_BRIDGE);

        hopFacet = TestHopFacet(address(diamond));
        hopFacet.initHop(configs);

        hopFacet.addDex(address(uniswap));
        hopFacet.setFunctionApprovalBySignature(uniswap.swapExactTokensForTokens.selector);
        hopFacet.setFunctionApprovalBySignature(uniswap.swapETHForExactTokens.selector);
        setFacetAddressInTestBase(address(hopFacet));

        //TODO from here

        validBridgeData = ILiFi.BridgeData({
            transactionId: "",
            bridge: "hop",
            integrator: "",
            referrer: address(0),
            sendingAssetId: DAI_ADDRESS,
            receiver: DAI_HOLDER,
            minAmount: 10 * 10**dai.decimals(),
            destinationChainId: DSTCHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        validHopData = HopFacet.HopData(
            0,
            0,
            block.timestamp + 60 * 20,
            9 * 10**dai.decimals(),
            block.timestamp + 60 * 20
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hopFacet.startBridgeTokensViaHop{ value: bridgeData.minAmount }(bridgeData, validHopData);
        } else {
            hopFacet.startBridgeTokensViaHop(bridgeData, validHopData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            hopFacet.swapAndStartBridgeTokensViaHop{ value: bridgeData.minAmount }(bridgeData, swapData, validHopData);
        } else {
            hopFacet.swapAndStartBridgeTokensViaHop(bridgeData, swapData, validHopData);
        }
    }

    //TODO implement reentrancy etc.
    function testFailReentrantCallBridge() public {
        // prepare bridge data for native bridging
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(hopFacet.startBridgeTokensViaHop.selector, bridgeData, validHopData)
        );
    }

    function testFailReentrantCallBridgeAndSwap() public {
        // prepare bridge data for native bridging
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        // call testcase with correct call data (i.e. function selector) for this facet
        super.failReentrantCall(
            abi.encodeWithSelector(hopFacet.swapAndStartBridgeTokensViaHop.selector, bridgeData, swapData, validHopData)
        );
    }

    function testFailWillRevertIfNotEnoughMsgValue() public {
        vm.startPrank(USER_USDC_WHALE);
        // prepare bridgeData
        setDefaultBridgeData();
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        hopFacet.startBridgeTokensViaHop{ value: bridgeData.minAmount - 1 }(bridgeData, validHopData);

        vm.stopPrank();
    }
}
