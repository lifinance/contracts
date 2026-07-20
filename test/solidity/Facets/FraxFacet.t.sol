// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase, ILiFi, LibSwap, ERC20 } from "../utils/TestBase.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { MockUniswapDEX } from "../utils/MockUniswapDEX.sol";
import { TestToken } from "../utils/TestToken.sol";
import { MockFraxHopV2Tempo, MockFraxOFT, MockTipFeeManager } from "../utils/MockFraxHopV2Tempo.sol";
import { FraxFacet } from "lifi/Facets/FraxFacet.sol";
import { IFraxHopV2 } from "lifi/Interfaces/IFraxHopV2.sol";
import { InformationMismatch, InvalidCallData, InvalidConfig, NotInitialized, OnlyContractOwner, TransferFromFailed, UnsupportedChainId } from "lifi/Errors/GenericErrors.sol";

// Stub FraxFacet: adds the whitelist-manager selectors so pre-bridge swaps can be tested
contract TestFraxFacet is FraxFacet, TestWhitelistManagerBase {
    constructor(
        IFraxHopV2 _hop,
        address _tipFeeManager,
        address _pathUsd
    ) FraxFacet(_hop, _tipFeeManager, _pathUsd) {}
}

/// @notice Fork tests for the standard (native-fee) FraxFacet path against the real
///         Frax HopV2 spoke and the frxUSD self-OFT on Arbitrum. frxUSD is a self-OFT
///         (token == oft), 18 decimals, dust granularity 1e12.
contract FraxFacetTest is TestBaseFacet {
    // Frax HopV2 spoke on Arbitrum (approvalAddress + call target)
    address internal constant HOP = 0x0000006D38568b00B457580b734e0076C62de659;
    // frxUSD self-OFT (bridgeData.sendingAssetId == fraxData.oft == this)
    address internal constant FRXUSD =
        0x80Eede496655FB9047dd39d9f418d5483ED600df;
    uint32 internal constant DST_EID_FRAXTAL = 30255; // hub
    uint256 internal constant DST_CHAINID_FRAXTAL = 252; // Fraxtal chainId
    uint256 internal constant DUST_RATE = 1e12; // frxUSD decimalConversionRate

    event FraxChainMappingsInitialized(
        FraxFacet.ChainIdConfig[] chainIdConfigs
    );
    event ChainIdToEidSet(uint256 indexed chainId, uint32 lzEid);

    TestFraxFacet internal fraxFacet;
    FraxFacet.FraxData internal fraxData;
    MockUniswapDEX internal mockDex;
    ERC20 internal frxUSD;

    uint256 internal defaultFrxAmount;

    /// @dev Minimal chainId -> EID seeding for the fork tests (bridge to Fraxtal).
    function _defaultChainIdConfigs()
        internal
        pure
        returns (FraxFacet.ChainIdConfig[] memory configs)
    {
        configs = new FraxFacet.ChainIdConfig[](2);
        configs[0] = FraxFacet.ChainIdConfig({
            chainId: DST_CHAINID_FRAXTAL,
            lzEid: DST_EID_FRAXTAL
        }); // Fraxtal
        configs[1] = FraxFacet.ChainIdConfig({ chainId: 8453, lzEid: 30184 }); // Base
    }

    function setUp() public {
        // Arbitrum fork pinned to a block where frxUSD is an approvedOft on the hop
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        customBlockNumberForForking = 483300000;
        initTestBase();

        frxUSD = ERC20(FRXUSD);
        defaultFrxAmount = 100 * 1e18;

        // fund the sender with frxUSD (standard TransparentUpgradeableProxy ERC20)
        deal(FRXUSD, USER_SENDER, 1_000_000 * 1e18);

        // deploy facet in standard (non-Tempo) configuration
        fraxFacet = new TestFraxFacet(IFraxHopV2(HOP), address(0), address(0));

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = fraxFacet.startBridgeTokensViaFrax.selector;
        functionSelectors[1] = fraxFacet
            .swapAndStartBridgeTokensViaFrax
            .selector;
        functionSelectors[2] = fraxFacet.addAllowedContractSelector.selector;
        functionSelectors[3] = fraxFacet
            .removeAllowedContractSelector
            .selector;
        functionSelectors[4] = fraxFacet.initFrax.selector;
        functionSelectors[5] = fraxFacet.setChainIdToEid.selector;
        functionSelectors[6] = fraxFacet.getChainIdToEid.selector;

        addFacet(diamond, address(fraxFacet), functionSelectors);
        fraxFacet = TestFraxFacet(payable(address(diamond)));

        // seed the chainId -> LayerZero EID mapping (owner-only)
        vm.prank(USER_DIAMOND_OWNER);
        fraxFacet.initFrax(_defaultChainIdConfigs());

        // mock DEX for pre-bridge swaps whose OUTPUT is frxUSD (the facet requires the
        // final swap receivingAssetId == sendingAssetId == frxUSD); no reliable on-fork
        // route to frxUSD exists at this block, so a preset-output mock is used (rule 400)
        mockDex = new MockUniswapDEX();
        deal(FRXUSD, address(mockDex), 1_000_000 * 1e18);
        mockDex.setSwapOutput(
            defaultUSDCAmount,
            ERC20(FRXUSD),
            defaultFrxAmount
        );

        fraxFacet.addAllowedContractSelector(
            address(mockDex),
            mockDex.swapExactTokensForTokens.selector
        );

        setFacetAddressInTestBase(address(fraxFacet), "FraxFacet");

        // default bridgeData bridges frxUSD to Fraxtal
        bridgeData.bridge = "frax";
        bridgeData.sendingAssetId = FRXUSD;
        bridgeData.minAmount = defaultFrxAmount;
        bridgeData.destinationChainId = DST_CHAINID_FRAXTAL;

        fraxData = FraxFacet.FraxData({
            oft: FRXUSD,
            dstEid: DST_EID_FRAXTAL,
            nativeFee: _quote(defaultFrxAmount),
            refundRecipient: USER_REFUND
        });

        vm.label(HOP, "FraxHopV2");
        vm.label(FRXUSD, "frxUSD");
        vm.label(address(mockDex), "MockUniswapDEX");
    }

    /// @dev Live native LZ fee for bridging `amount` of frxUSD to Fraxtal
    function _quote(uint256 amount) internal view returns (uint256) {
        return
            IFraxHopV2(HOP).quote(
                FRXUSD,
                DST_EID_FRAXTAL,
                bytes32(uint256(uint160(USER_RECEIVER))),
                amount,
                0,
                ""
            );
    }

    /// @dev Build a USDC -> frxUSD swap through the mock DEX (receivingAssetId == frxUSD)
    function setDefaultSwapDataSingleDAItoUSDC() internal override {
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = FRXUSD;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDex),
                approveTo: address(mockDex),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: FRXUSD,
                fromAmount: defaultUSDCAmount,
                callData: abi.encodeWithSelector(
                    mockDex.swapExactTokensForTokens.selector,
                    defaultUSDCAmount,
                    defaultFrxAmount,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            fraxFacet.startBridgeTokensViaFrax{ value: bridgeData.minAmount }(
                bridgeData,
                fraxData
            );
        } else {
            fraxFacet.startBridgeTokensViaFrax{ value: fraxData.nativeFee }(
                bridgeData,
                fraxData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            fraxFacet.swapAndStartBridgeTokensViaFrax{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, fraxData);
        } else {
            fraxFacet.swapAndStartBridgeTokensViaFrax{
                value: fraxData.nativeFee
            }(bridgeData, swapData, fraxData);
        }
    }

    // FraxFacet supports only ERC20 OFTs; no native path
    function testBase_CanBridgeNativeTokens() public override {}

    // FraxFacet supports only ERC20 OFTs; no native path
    function testBase_CanSwapAndBridgeNativeTokens() public override {}

    function testBase_CanBridgeTokens() public override {
        uint256 senderBefore = frxUSD.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        // diamond custodies nothing after the bridge
        assertEq(frxUSD.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
        assertEq(
            frxUSD.balanceOf(USER_SENDER),
            senderBefore - defaultFrxAmount
        );
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 1e18; // multiple of the 1e12 dust rate -> no dust

        bridgeData.minAmount = amount;
        fraxData.nativeFee = _quote(amount);

        uint256 senderBefore = frxUSD.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, amount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(frxUSD.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
        assertEq(frxUSD.balanceOf(USER_SENDER), senderBefore - amount);
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();

        // output of the swap becomes the bridged amount (clean multiple of dust rate)
        bridgeData.minAmount = defaultFrxAmount;

        uint256 senderUsdcBefore = usdc.balanceOf(USER_SENDER);
        usdc.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            address(mockDex),
            ADDRESS_USDC,
            FRXUSD,
            swapData[0].fromAmount,
            defaultFrxAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        // nothing stranded in the diamond (neither the swapped-in nor the bridged asset)
        assertEq(frxUSD.balanceOf(address(diamond)), 0);
        assertEq(usdc.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
        assertEq(
            usdc.balanceOf(USER_SENDER),
            senderUsdcBefore - defaultUSDCAmount
        );
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        vm.startPrank(USER_SENDER);

        frxUSD.approve(_facetTestContractAddress, defaultFrxAmount);
        // drain the sender's frxUSD so depositAsset's transferFrom fails
        frxUSD.transfer(USER_RECEIVER, frxUSD.balanceOf(USER_SENDER));

        vm.expectRevert(TransferFromFailed.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// Additional money-flow and validation tests ///

    function test_DustIsFlooredAndRefundedToRefundRecipient() public {
        // minAmount = 100e18 + 1e6; 1e6 < 1e12 dust rate -> floored to 100e18, 1e6 dust
        uint256 dust = 1e6;
        bridgeData.minAmount = defaultFrxAmount + dust;
        fraxData.nativeFee = _quote(defaultFrxAmount);

        uint256 senderBefore = frxUSD.balanceOf(USER_SENDER);
        uint256 refundBefore = frxUSD.balanceOf(USER_REFUND);

        // the emitted (and bridged) amount is the floored amount, not minAmount
        ILiFi.BridgeData memory emittedData = bridgeData;
        emittedData.minAmount = defaultFrxAmount;

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(emittedData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        // sender debited the full amount; dust returned to refundRecipient; diamond holds 0
        assertEq(
            frxUSD.balanceOf(USER_SENDER),
            senderBefore - defaultFrxAmount - dust
        );
        assertEq(frxUSD.balanceOf(USER_REFUND), refundBefore + dust);
        assertEq(frxUSD.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
    }

    function testRevert_WhenFlooredAmountIsZero() public {
        // 5e11 < 1e12 -> the whole amount is dust -> flooredAmount == 0
        bridgeData.minAmount = 5e11;
        fraxData.nativeFee = _quote(defaultFrxAmount);

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_ExcessNativeIsRefundedToRefundRecipient() public {
        uint256 excess = 0.01 ether;
        uint256 refundBefore = USER_REFUND.balance;

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        fraxFacet.startBridgeTokensViaFrax{
            value: fraxData.nativeFee + excess
        }(bridgeData, fraxData);
        vm.stopPrank();

        // the excess (and any LZ overpayment) is forwarded to the refundRecipient
        assertGe(USER_REFUND.balance, refundBefore + excess);
        assertEq(address(diamond).balance, 0);
    }

    function testRevert_WhenNativeFeeExceedsMsgValue() public {
        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        fraxFacet.startBridgeTokensViaFrax{ value: fraxData.nativeFee - 1 }(
            bridgeData,
            fraxData
        );
        vm.stopPrank();
    }

    function testRevert_WhenOftTokenMismatchesSendingAsset() public {
        // an OFT whose token() != sendingAssetId must be rejected
        MockFraxOFT wrongOft = new MockFraxOFT(ADDRESS_USDC);
        fraxData.oft = address(wrongOft);

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenBridgeWithZeroRefundRecipient() public {
        fraxData.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        fraxFacet.startBridgeTokensViaFrax{ value: fraxData.nativeFee }(
            bridgeData,
            fraxData
        );
        vm.stopPrank();
    }

    function testRevert_WhenBridgeWithZeroOft() public {
        fraxData.oft = address(0);

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenBridgeWithZeroDstEid() public {
        fraxData.dstEid = 0;

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwapAndBridgeWithZeroRefundRecipient() public {
        fraxData.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        usdc.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwapOutputAssetMismatchesBridgeAsset() public {
        // the final swap output must equal the bridged sendingAssetId (frxUSD)
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        // break the invariant: last swap now outputs USDC, not frxUSD
        swapData[0].receivingAssetId = ADDRESS_USDC;
        usdc.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InformationMismatch.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_WillStoreConstructorParametersCorrectly() public {
        fraxFacet = new TestFraxFacet(IFraxHopV2(HOP), address(0), address(0));
        assertEq(address(fraxFacet.HOP()), HOP);
        assertEq(fraxFacet.TIP_FEE_MANAGER(), address(0));
        assertEq(fraxFacet.PATH_USD(), address(0));
    }

    function testRevert_WhenConstructedWithZeroHop() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestFraxFacet(IFraxHopV2(address(0)), address(0), address(0));
    }

    function testRevert_WhenConstructedWithHalfTempoConfig() public {
        // tipFeeManager set but pathUsd zero -> half-configured Tempo deployment
        vm.expectRevert(InvalidConfig.selector);
        new TestFraxFacet(
            IFraxHopV2(HOP),
            0xfeEC000000000000000000000000000000000000,
            address(0)
        );
    }

    function testRevert_WhenConstructedWithOtherHalfTempoConfig() public {
        // pathUsd set but tipFeeManager zero -> the mirror half-config
        vm.expectRevert(InvalidConfig.selector);
        new TestFraxFacet(
            IFraxHopV2(HOP),
            address(0),
            0x20C0000000000000000000000000000000000000
        );
    }

    /// ChainId -> LayerZero EID mapping (admin) ///

    function test_DefaultChainMappingsSeeded() public {
        assertEq(
            fraxFacet.getChainIdToEid(DST_CHAINID_FRAXTAL),
            DST_EID_FRAXTAL
        );
        assertEq(fraxFacet.getChainIdToEid(8453), 30184);
    }

    function testRevert_GetChainIdToEidUnsupported() public {
        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 99999)
        );
        fraxFacet.getChainIdToEid(99999);
    }

    function test_CanSetChainIdToEid() public {
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({ chainId: 137, lzEid: 30109 });

        vm.expectEmit(true, true, true, true, address(fraxFacet));
        emit ChainIdToEidSet(137, 30109);

        vm.prank(USER_DIAMOND_OWNER);
        fraxFacet.setChainIdToEid(configs);

        assertEq(fraxFacet.getChainIdToEid(137), 30109);

        // updating an existing entry overwrites and re-emits
        configs[0].lzEid = 30111;
        vm.expectEmit(true, true, true, true, address(fraxFacet));
        emit ChainIdToEidSet(137, 30111);

        vm.prank(USER_DIAMOND_OWNER);
        fraxFacet.setChainIdToEid(configs);

        assertEq(fraxFacet.getChainIdToEid(137), 30111);
    }

    function testRevert_SetChainIdToEidFromNonOwner() public {
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({ chainId: 137, lzEid: 30109 });

        vm.prank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        fraxFacet.setChainIdToEid(configs);
    }

    function testRevert_SetChainIdToEidEmpty() public {
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](0);

        vm.prank(USER_DIAMOND_OWNER);
        vm.expectRevert(InvalidConfig.selector);
        fraxFacet.setChainIdToEid(configs);
    }

    function testRevert_SetChainIdToEidZeroChainId() public {
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({ chainId: 0, lzEid: 30109 });

        vm.prank(USER_DIAMOND_OWNER);
        vm.expectRevert(InvalidConfig.selector);
        fraxFacet.setChainIdToEid(configs);
    }

    function testRevert_SetChainIdToEidZeroEid() public {
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({ chainId: 137, lzEid: 0 });

        vm.prank(USER_DIAMOND_OWNER);
        vm.expectRevert(InvalidConfig.selector);
        fraxFacet.setChainIdToEid(configs);
    }

    function testRevert_SetChainIdToEidBeforeInit() public {
        // fresh standalone facet: diamond-storage owner defaults to address(0),
        // and the mapping has never been initialized
        TestFraxFacet fresh = new TestFraxFacet(
            IFraxHopV2(HOP),
            address(0),
            address(0)
        );

        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({ chainId: 137, lzEid: 30109 });

        vm.prank(address(0));
        vm.expectRevert(NotInitialized.selector);
        fresh.setChainIdToEid(configs);
    }

    function test_InitFraxEmitsAndSetsMappings() public {
        TestFraxFacet fresh = new TestFraxFacet(
            IFraxHopV2(HOP),
            address(0),
            address(0)
        );
        FraxFacet.ChainIdConfig[] memory configs = _defaultChainIdConfigs();

        vm.prank(address(0));
        vm.expectEmit(true, true, true, true, address(fresh));
        emit ChainIdToEidSet(configs[0].chainId, configs[0].lzEid);
        vm.expectEmit(true, true, true, true, address(fresh));
        emit ChainIdToEidSet(configs[1].chainId, configs[1].lzEid);
        vm.expectEmit(true, true, true, true, address(fresh));
        emit FraxChainMappingsInitialized(configs);

        fresh.initFrax(configs);

        assertEq(fresh.getChainIdToEid(DST_CHAINID_FRAXTAL), DST_EID_FRAXTAL);
        assertEq(fresh.getChainIdToEid(8453), 30184);
    }

    function testRevert_InitFraxFromNonOwner() public {
        vm.prank(USER_SENDER);
        vm.expectRevert(OnlyContractOwner.selector);
        fraxFacet.initFrax(_defaultChainIdConfigs());
    }

    function testRevert_InitFraxEmpty() public {
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](0);

        vm.prank(USER_DIAMOND_OWNER);
        vm.expectRevert(InvalidConfig.selector);
        fraxFacet.initFrax(configs);
    }

    function testRevert_InitFraxZeroChainId() public {
        TestFraxFacet fresh = new TestFraxFacet(
            IFraxHopV2(HOP),
            address(0),
            address(0)
        );
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({ chainId: 0, lzEid: 30255 });

        vm.prank(address(0));
        vm.expectRevert(InvalidConfig.selector);
        fresh.initFrax(configs);
    }

    function testRevert_InitFraxZeroEid() public {
        TestFraxFacet fresh = new TestFraxFacet(
            IFraxHopV2(HOP),
            address(0),
            address(0)
        );
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({
            chainId: DST_CHAINID_FRAXTAL,
            lzEid: 0
        });

        vm.prank(address(0));
        vm.expectRevert(InvalidConfig.selector);
        fresh.initFrax(configs);
    }

    /// destinationChainId <-> dstEid cross-check ///

    function testRevert_WhenDestinationChainIdMismatchesDstEid() public {
        // destinationChainId is Fraxtal (-> 30255) but dstEid is Base's EID
        fraxData.dstEid = 30184;

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenDestinationChainUnsupported() public {
        // a destinationChainId with no configured EID must revert
        bridgeData.destinationChainId = 999999;

        vm.startPrank(USER_SENDER);
        frxUSD.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 999999)
        );
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }
}

/// @notice Local (non-fork) tests for the Tempo (ERC20-fee) FraxFacet branch.
/// @dev Rationale (rule 400): the real Tempo chain relies on precompile-backed TIP20
///      tokens and a LayerZero EndpointV2Alt implemented at the node level, which a
///      Foundry fork cannot execute (deal/transferFrom/sendOFT all fail on codesize-1
///      precompiles). A mock hop + fee manager reproduce the exact Tempo money flow the
///      facet depends on: ERC20 fee quote, msg.value==0 requirement, and a transferFrom
///      pull of both the bridged token and the fee token from the diamond.
contract FraxFacetTempoTest is TestBase {
    TestFraxFacet internal fraxFacet;
    FraxFacet.FraxData internal fraxData;

    MockFraxHopV2Tempo internal hop;
    MockFraxOFT internal oft;
    MockTipFeeManager internal tipFeeManager;
    TestToken internal bridgedToken; // frxUSD-style, 18 decimals
    TestToken internal pathUsd; // default Tempo gas token, 6 decimals

    uint256 internal constant BRIDGE_AMOUNT = 100 * 1e18;
    uint256 internal constant FEE_QUOTE = 5 * 1e6;
    uint256 internal constant DUST_RATE = 1e12;

    function setUp() public {
        initTestBaseLocal();

        bridgedToken = new TestToken("frxUSD", "frxUSD", 18);
        pathUsd = new TestToken("Path USD", "PUSD", 6);

        oft = new MockFraxOFT(address(bridgedToken));
        tipFeeManager = new MockTipFeeManager();
        hop = new MockFraxHopV2Tempo(DUST_RATE);
        hop.setFeeConfig(address(pathUsd), FEE_QUOTE, FEE_QUOTE);

        fraxFacet = new TestFraxFacet(
            IFraxHopV2(address(hop)),
            address(tipFeeManager),
            address(pathUsd)
        );

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = fraxFacet.startBridgeTokensViaFrax.selector;
        functionSelectors[1] = fraxFacet
            .swapAndStartBridgeTokensViaFrax
            .selector;
        functionSelectors[2] = fraxFacet.addAllowedContractSelector.selector;
        functionSelectors[3] = fraxFacet
            .removeAllowedContractSelector
            .selector;
        functionSelectors[4] = fraxFacet.initFrax.selector;
        functionSelectors[5] = fraxFacet.setChainIdToEid.selector;
        functionSelectors[6] = fraxFacet.getChainIdToEid.selector;

        addFacet(diamond, address(fraxFacet), functionSelectors);
        fraxFacet = TestFraxFacet(payable(address(diamond)));

        // seed the chainId -> LayerZero EID mapping (owner-only): Fraxtal 252 -> 30255
        FraxFacet.ChainIdConfig[]
            memory configs = new FraxFacet.ChainIdConfig[](1);
        configs[0] = FraxFacet.ChainIdConfig({ chainId: 252, lzEid: 30255 });
        vm.prank(USER_DIAMOND_OWNER);
        fraxFacet.initFrax(configs);

        // fund the sender with the bridged token and the fee token
        bridgedToken.mint(USER_SENDER, 1_000_000 * 1e18);
        pathUsd.mint(USER_SENDER, 1_000_000 * 1e6);

        bridgeData = ILiFi.BridgeData({
            transactionId: "tempoTx",
            bridge: "frax",
            integrator: "",
            referrer: address(0),
            sendingAssetId: address(bridgedToken),
            receiver: USER_RECEIVER,
            minAmount: BRIDGE_AMOUNT,
            destinationChainId: 252,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        fraxData = FraxFacet.FraxData({
            oft: address(oft),
            dstEid: 30255,
            nativeFee: 0,
            refundRecipient: USER_REFUND
        });

        vm.label(address(hop), "MockFraxHopV2Tempo");
        vm.label(address(bridgedToken), "bridgedToken");
        vm.label(address(pathUsd), "PATH_USD");
    }

    function test_Tempo_BridgeChargesFeeInErc20AndRetainsNothing() public {
        uint256 senderBridgedBefore = bridgedToken.balanceOf(USER_SENDER);
        uint256 senderFeeBefore = pathUsd.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        bridgedToken.approve(address(fraxFacet), BRIDGE_AMOUNT);
        pathUsd.approve(address(fraxFacet), FEE_QUOTE);

        vm.expectEmit(true, true, true, true, address(fraxFacet));
        emit LiFiTransferStarted(bridgeData);

        // Tempo path: no native is ever sent
        fraxFacet.startBridgeTokensViaFrax{ value: 0 }(bridgeData, fraxData);
        vm.stopPrank();

        // the hop pulled the bridged token and the ERC20 fee
        assertEq(bridgedToken.balanceOf(address(hop)), BRIDGE_AMOUNT);
        assertEq(pathUsd.balanceOf(address(hop)), FEE_QUOTE);
        // sender debited both; diamond retains neither
        assertEq(
            bridgedToken.balanceOf(USER_SENDER),
            senderBridgedBefore - BRIDGE_AMOUNT
        );
        assertEq(pathUsd.balanceOf(USER_SENDER), senderFeeBefore - FEE_QUOTE);
        assertEq(bridgedToken.balanceOf(address(fraxFacet)), 0);
        assertEq(pathUsd.balanceOf(address(fraxFacet)), 0);
    }

    function testRevert_Tempo_WhenNativeSent() public {
        vm.deal(USER_SENDER, 1 ether);
        vm.startPrank(USER_SENDER);
        bridgedToken.approve(address(fraxFacet), BRIDGE_AMOUNT);
        pathUsd.approve(address(fraxFacet), FEE_QUOTE);

        vm.expectRevert(InvalidCallData.selector);

        fraxFacet.startBridgeTokensViaFrax{ value: 1 }(bridgeData, fraxData);
        vm.stopPrank();
    }

    function test_Tempo_UnusedFeeReturnedToRefundRecipient() public {
        // hop pulls only 4e6 of the 5e6 quoted fee -> 1e6 unused stays in the diamond
        // and must be swept to the refundRecipient
        uint256 feePull = 4 * 1e6;
        hop.setFeeConfig(address(pathUsd), FEE_QUOTE, feePull);

        uint256 refundBefore = pathUsd.balanceOf(USER_REFUND);

        vm.startPrank(USER_SENDER);
        bridgedToken.approve(address(fraxFacet), BRIDGE_AMOUNT);
        pathUsd.approve(address(fraxFacet), FEE_QUOTE);

        fraxFacet.startBridgeTokensViaFrax{ value: 0 }(bridgeData, fraxData);
        vm.stopPrank();

        assertEq(
            pathUsd.balanceOf(USER_REFUND),
            refundBefore + (FEE_QUOTE - feePull)
        );
        assertEq(pathUsd.balanceOf(address(fraxFacet)), 0);
    }

    function test_Tempo_ZeroFeeQuoteSkipsFeeDeposit() public {
        // a zero fee quote must skip the fee deposit/approve entirely
        hop.setFeeConfig(address(pathUsd), 0, 0);

        uint256 senderFeeBefore = pathUsd.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        bridgedToken.approve(address(fraxFacet), BRIDGE_AMOUNT);

        fraxFacet.startBridgeTokensViaFrax{ value: 0 }(bridgeData, fraxData);
        vm.stopPrank();

        // bridged token still moved; no fee token pulled; diamond retains nothing
        assertEq(bridgedToken.balanceOf(address(hop)), BRIDGE_AMOUNT);
        assertEq(pathUsd.balanceOf(USER_SENDER), senderFeeBefore);
        assertEq(pathUsd.balanceOf(address(hop)), 0);
        assertEq(bridgedToken.balanceOf(address(fraxFacet)), 0);
        assertEq(pathUsd.balanceOf(address(fraxFacet)), 0);
    }

    function test_Tempo_UsesOptedInFeeToken() public {
        // the diamond has opted into a specific TIP20 gas token via the fee manager
        TestToken feeToken2 = new TestToken("Fee Token 2", "FEE2", 6);
        feeToken2.mint(USER_SENDER, 1_000_000 * 1e6);
        tipFeeManager.setUserToken(address(fraxFacet), address(feeToken2));
        hop.setFeeConfig(address(feeToken2), FEE_QUOTE, FEE_QUOTE);

        vm.startPrank(USER_SENDER);
        bridgedToken.approve(address(fraxFacet), BRIDGE_AMOUNT);
        feeToken2.approve(address(fraxFacet), FEE_QUOTE);

        fraxFacet.startBridgeTokensViaFrax{ value: 0 }(bridgeData, fraxData);
        vm.stopPrank();

        // fee charged in the opted-in token, not PATH_USD
        assertEq(feeToken2.balanceOf(address(hop)), FEE_QUOTE);
        assertEq(pathUsd.balanceOf(address(hop)), 0);
        assertEq(feeToken2.balanceOf(address(fraxFacet)), 0);
    }

    function test_Tempo_SwapAndBridgeChargesErc20FeeAndRetainsNothing()
        public
    {
        // pre-bridge swap (USDC -> bridged token) followed by a Tempo (ERC20-fee) bridge
        MockUniswapDEX mockDex = new MockUniswapDEX();
        bridgedToken.mint(address(mockDex), BRIDGE_AMOUNT);
        mockDex.setSwapOutput(
            defaultUSDCAmount,
            ERC20(address(bridgedToken)),
            BRIDGE_AMOUNT
        );
        fraxFacet.addAllowedContractSelector(
            address(mockDex),
            mockDex.swapExactTokensForTokens.selector
        );

        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = address(bridgedToken);

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDex),
                approveTo: address(mockDex),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(bridgedToken),
                fromAmount: defaultUSDCAmount,
                callData: abi.encodeWithSelector(
                    mockDex.swapExactTokensForTokens.selector,
                    defaultUSDCAmount,
                    BRIDGE_AMOUNT,
                    path,
                    address(fraxFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        bridgeData.hasSourceSwaps = true;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(fraxFacet), defaultUSDCAmount);
        pathUsd.approve(address(fraxFacet), FEE_QUOTE);

        vm.expectEmit(true, true, true, true, address(fraxFacet));
        emit LiFiTransferStarted(bridgeData);

        fraxFacet.swapAndStartBridgeTokensViaFrax{ value: 0 }(
            bridgeData,
            swapData,
            fraxData
        );
        vm.stopPrank();

        // bridged token + ERC20 fee pulled by the hop; diamond keeps nothing
        assertEq(bridgedToken.balanceOf(address(hop)), BRIDGE_AMOUNT);
        assertEq(pathUsd.balanceOf(address(hop)), FEE_QUOTE);
        assertEq(bridgedToken.balanceOf(address(fraxFacet)), 0);
        assertEq(usdc.balanceOf(address(fraxFacet)), 0);
        assertEq(pathUsd.balanceOf(address(fraxFacet)), 0);
    }

    function testRevert_Tempo_SwapAndBridgeWhenNativeSent() public {
        // symmetric msg.value guard on the swap entry point
        vm.deal(USER_SENDER, 1 ether);

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = address(pathUsd);
        path[1] = address(bridgedToken);
        swapData.push(
            LibSwap.SwapData({
                callTo: address(hop),
                approveTo: address(hop),
                sendingAssetId: address(pathUsd),
                receivingAssetId: address(bridgedToken),
                fromAmount: 1,
                callData: abi.encodeWithSelector(bytes4(0x12345678)),
                requiresDeposit: true
            })
        );

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;

        vm.expectRevert(InvalidCallData.selector);

        fraxFacet.swapAndStartBridgeTokensViaFrax{ value: 1 }(
            bridgeData,
            swapData,
            fraxData
        );
        vm.stopPrank();
    }

    function testRevert_Tempo_WhenFeeTokenEqualsBridgedToken() public {
        // opting the diamond's gas token into the bridged token would corrupt the
        // unused-fee balance-delta accounting; the facet must reject the collision
        tipFeeManager.setUserToken(address(fraxFacet), address(bridgedToken));
        hop.setFeeConfig(address(bridgedToken), FEE_QUOTE, FEE_QUOTE);

        vm.startPrank(USER_SENDER);
        bridgedToken.approve(address(fraxFacet), BRIDGE_AMOUNT);

        vm.expectRevert(InformationMismatch.selector);
        fraxFacet.startBridgeTokensViaFrax{ value: 0 }(bridgeData, fraxData);
        vm.stopPrank();
    }
}
