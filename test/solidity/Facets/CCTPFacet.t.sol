// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { CCTPFacet } from "lifi/Facets/CCTPFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ITokenMessenger } from "lifi/Interfaces/ITokenMessenger.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
import {
    TestWhitelistManagerBase
} from "../utils/TestWhitelistManagerBase.sol";
import { LiFiDiamond } from "../utils/DiamondTest.sol";
import {
    InvalidCallData,
    InvalidConfig,
    InvalidNonEVMReceiver,
    InvalidReceiver,
    InvalidSendingToken,
    NotInitialized,
    OnlyContractOwner,
    UnsupportedChainId
} from "lifi/Errors/GenericErrors.sol";

contract TestCCTPFacet is CCTPFacet, TestWhitelistManagerBase {
    constructor(address _tokenMessenger, address _usdc)
        CCTPFacet(_tokenMessenger, _usdc)
    { }
}

contract CCTPFacetTest is TestBaseFacet {
    event CCTPChainMappingsInitialized(CCTPFacet
                .ChainIdConfig[] chainIdConfigs);

    event CCTPChainIdToDomainIdSet(uint256 indexed chainId, uint32 domainId);

    event CCTPChainIdToDomainIdUnset(uint256 indexed chainId);

    TestCCTPFacet internal cctpFacet;
    address internal constant TOKEN_MESSENGER_V2_MAINNET =
        0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    // Must match CCTPFacet.HYPERCORE_CCTP_FORWARDER
    bytes32 internal constant HYPERCORE_CCTP_FORWARDER =
        0x000000000000000000000000b21d281dedb17ae5b501f6aa8256fe38c4e45757;
    uint32 internal constant HYPEREVM_CCTP_DOMAIN = 19;
    // Must match CCTPFacet.STELLAR_CCTP_FORWARDER (Stellar mainnet CctpForwarder)
    bytes32 internal constant STELLAR_CCTP_FORWARDER =
        0x72bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291;
    uint32 internal constant STELLAR_CCTP_DOMAIN = 27;
    uint32 internal constant BASE_CCTP_DOMAIN = 6;
    uint32 internal constant SOLANA_CCTP_DOMAIN = 5;
    bytes internal constant STELLAR_STRKEY =
        "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX";

    CCTPFacet.CCTPData internal validCCTPData;

    function setUp() public {
        customBlockNumberForForking = 23767209;
        initTestBase();

        cctpFacet = new TestCCTPFacet(TOKEN_MESSENGER_V2_MAINNET, ADDRESS_USDC);

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = cctpFacet.startBridgeTokensViaCCTP.selector;
        functionSelectors[1] =
        cctpFacet.swapAndStartBridgeTokensViaCCTP.selector;
        functionSelectors[2] = cctpFacet.addAllowedContractSelector.selector;
        functionSelectors[3] = cctpFacet.getCCTPChainIdToDomainId.selector;
        functionSelectors[4] = cctpFacet.initCCTP.selector;
        functionSelectors[5] = cctpFacet.setCCTPChainIdToDomainId.selector;
        functionSelectors[6] = cctpFacet.unsetCCTPChainIdToDomainId.selector;

        addFacet(diamond, address(cctpFacet), functionSelectors);
        cctpFacet = TestCCTPFacet(address(diamond));

        vm.startPrank(USER_DIAMOND_OWNER);

        cctpFacet.initCCTP(_defaultChainIdConfigs());

        vm.stopPrank();

        cctpFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP, uniswap.swapExactTokensForTokens.selector
        );

        setFacetAddressInTestBase(address(cctpFacet), "CCTPFacet");

        bridgeData.bridge = "cctp";
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.destinationChainId = 8453; // Base

        validCCTPData = CCTPFacet.CCTPData({
            maxCCTPFee: (bridgeData.minAmount / 100) * 10, // 10% of bridging amount
            nonEVMReceiver: bytes32(0),
            solanaReceiverATA: bytes32(0),
            minFinalityThreshold: 1000, // Fast route (1000)
            refundRecipient: USER_REFUND,
            hookData: ""
        });

        assertEq(
            usdc.allowance(address(diamond), TOKEN_MESSENGER_V2_MAINNET),
            type(uint256).max
        );
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        cctpFacet.startBridgeTokensViaCCTP(bridgeData, validCCTPData);
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        cctpFacet.swapAndStartBridgeTokensViaCCTP(
            bridgeData, swapData, validCCTPData
        );
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();

        bridgeData.minAmount = amount;
        validCCTPData.maxCCTPFee = amount / 10;

        usdc.approve(_facetTestContractAddress, amount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;
        validCCTPData.maxCCTPFee = defaultUSDCAmount / 10;

        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            defaultUSDCAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidReceiverAddress()
        public
        override
    {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = address(0);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testBase_Revert_BridgeAndSwapWithInvalidReceiverAddress()
        public
        override
    {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = address(0);
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;

        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidReceiver.selector);

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    function testRevert_ConstructorWithZeroTokenMessenger() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestCCTPFacet(address(0), ADDRESS_USDC);
    }

    function testRevert_ConstructorWithZeroUSDC() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestCCTPFacet(TOKEN_MESSENGER_V2_MAINNET, address(0));
    }

    function test_ConstructorSetsImmutables() public {
        CCTPFacet facet =
            new CCTPFacet(TOKEN_MESSENGER_V2_MAINNET, ADDRESS_USDC);

        assertEq(
            address(facet.CCTP_TOKEN_MESSENGER()), TOKEN_MESSENGER_V2_MAINNET
        );
        assertEq(facet.CCTP_USDC(), ADDRESS_USDC);
    }

    // ---------------------------------------------------------------------
    // Generic input validation
    // ---------------------------------------------------------------------

    function testRevert_InvalidSendingToken() public {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_DAI;
        dai.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSendingToken.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // EVM destinations
    // ---------------------------------------------------------------------

    function test_CanBridgeToEVMWithoutHookViaDepositForBurn() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurn,
                (
                    bridgeData.minAmount,
                    BASE_CCTP_DOMAIN,
                    LibBytes.toBytes32(bridgeData.receiver),
                    ADDRESS_USDC,
                    bytes32(0),
                    validCCTPData.maxCCTPFee,
                    validCCTPData.minFinalityThreshold
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeToEVMWithForwardingHook() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        validCCTPData.hookData = _buildForwardingHookData();

        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurnWithHook,
                (
                    bridgeData.minAmount,
                    BASE_CCTP_DOMAIN,
                    LibBytes.toBytes32(bridgeData.receiver),
                    ADDRESS_USDC,
                    bytes32(0),
                    validCCTPData.maxCCTPFee,
                    validCCTPData.minFinalityThreshold,
                    validCCTPData.hookData
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeToEVMWithHeaderOnlyHook() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        validCCTPData.hookData = abi.encodePacked(bytes24("cctp-forward"));

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_EVMHookWithWrongHeader() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        validCCTPData.hookData =
            abi.encodePacked(bytes24("cctp-forwarD"), uint32(0), uint32(0));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_EVMHookShorterThanHeader() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        // the header minus its last (zero) padding byte
        validCCTPData.hookData = abi.encodePacked(bytes23("cctp-forward"));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_EVMHookWithArbitraryPayload() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        validCCTPData.hookData = abi.encodeWithSignature(
            "transfer(address,uint256)", USER_RECEIVER, bridgeData.minAmount
        );

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_SentinelReceiverToEVMDestination() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        validCCTPData.nonEVMReceiver = LibBytes.toBytes32(address(0xBEEF));

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeWithFastRoute() public {
        _assertBridgesWithFinalityThreshold(1000);
    }

    function test_CanBridgeWithStandardRoute() public {
        _assertBridgesWithFinalityThreshold(2000);
    }

    // ---------------------------------------------------------------------
    // Solana
    // ---------------------------------------------------------------------

    function test_CanBridgeToSolanaWithoutHook() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        _setSolanaDestination();

        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurn,
                (
                    bridgeData.minAmount,
                    SOLANA_CCTP_DOMAIN,
                    validCCTPData.solanaReceiverATA,
                    ADDRESS_USDC,
                    bytes32(0),
                    validCCTPData.maxCCTPFee,
                    validCCTPData.minFinalityThreshold
                )
            )
        );

        // The event carries the owner wallet so the relayer derives the ATA itself
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit ILiFi.BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            validCCTPData.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeToSolanaWithForwardingHook() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        _setSolanaDestination();
        validCCTPData.hookData = _buildForwardingHookData();

        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurnWithHook,
                (
                    bridgeData.minAmount,
                    SOLANA_CCTP_DOMAIN,
                    validCCTPData.solanaReceiverATA,
                    ADDRESS_USDC,
                    bytes32(0),
                    validCCTPData.maxCCTPFee,
                    validCCTPData.minFinalityThreshold,
                    validCCTPData.hookData
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit ILiFi.BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            validCCTPData.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_SolanaHookWithWrongHeader() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        _setSolanaDestination();
        validCCTPData.hookData =
            abi.encodePacked(bytes24("not-a-forward"), uint32(0), uint32(0));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_EVMReceiverToSolanaDestination() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validCCTPData.solanaReceiverATA = bytes32(uint256(0x5678));

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_SolanaDestinationWithZeroNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        _setSolanaDestination();
        validCCTPData.nonEVMReceiver = bytes32(0);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_SolanaDestinationWithZeroSolanaReceiverATA() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        _setSolanaDestination();
        validCCTPData.solanaReceiverATA = bytes32(0);

        vm.expectRevert(InvalidConfig.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // HyperCore
    // ---------------------------------------------------------------------

    function test_CanBridgeToHyperCoreWithHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;
        validCCTPData.hookData = _buildHyperCoreHookData(bridgeData.receiver);

        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurnWithHook,
                (
                    bridgeData.minAmount,
                    HYPEREVM_CCTP_DOMAIN,
                    HYPERCORE_CCTP_FORWARDER,
                    ADDRESS_USDC,
                    HYPERCORE_CCTP_FORWARDER,
                    validCCTPData.maxCCTPFee,
                    validCCTPData.minFinalityThreshold,
                    validCCTPData.hookData
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeToHyperCoreWithMinimalHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;
        // Exactly 52 bytes: header + recipient, no destinationId
        validCCTPData.hookData = abi.encodePacked(
            bytes24("cctp-forward"), uint32(0), uint32(20), bridgeData.receiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_HyperCoreWithoutHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_HyperCoreWithNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;
        validCCTPData.hookData = _buildHyperCoreHookData(USER_RECEIVER);
        validCCTPData.nonEVMReceiver = bytes32(uint256(0x1234));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_HyperCoreHookReceiverMismatch() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;
        validCCTPData.hookData = _buildHyperCoreHookData(address(0xDEADBEEF));

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_HyperCoreZeroReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.receiver = address(0);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;
        validCCTPData.hookData = _buildHyperCoreHookData(address(0));

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_HyperCoreHookDataBelowMinLength() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;
        // 51 bytes: one below the minimum that contains a full recipient
        validCCTPData.hookData = new bytes(51);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Stellar
    // ---------------------------------------------------------------------

    function test_CanBridgeToStellarWithHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;
        validCCTPData.hookData = _buildStellarHookData(STELLAR_STRKEY);
        validCCTPData.nonEVMReceiver = bytes32(uint256(0xABCD));

        // Stellar (CCTP domain 27) is not registered on TokenMessengerV2 at the fork block,
        // and the remote domain is a hardcoded Circle-owned config, so the burn is mocked to
        // isolate the facet's dispatch/calldata (same approach as PolymerCCTPFacet's suite).
        vm.mockCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeWithSelector(
                ITokenMessenger.depositForBurnWithHook.selector
            ),
            abi.encode()
        );

        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurnWithHook,
                (
                    bridgeData.minAmount,
                    STELLAR_CCTP_DOMAIN,
                    STELLAR_CCTP_FORWARDER,
                    ADDRESS_USDC,
                    STELLAR_CCTP_FORWARDER,
                    validCCTPData.maxCCTPFee,
                    validCCTPData.minFinalityThreshold,
                    validCCTPData.hookData
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit ILiFi.BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_STELLAR,
            validCCTPData.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_StellarWithEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;
        validCCTPData.hookData = _buildStellarHookData(STELLAR_STRKEY);
        validCCTPData.nonEVMReceiver = bytes32(uint256(0xABCD));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_StellarWithoutNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;
        validCCTPData.hookData = _buildStellarHookData(STELLAR_STRKEY);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_StellarWithoutHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;
        validCCTPData.nonEVMReceiver = bytes32(uint256(0xABCD));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_StellarZeroLengthStrkey() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;
        validCCTPData.hookData =
            abi.encodePacked(bytes24("cctp-forward"), uint32(0), uint32(0));
        validCCTPData.nonEVMReceiver = bytes32(uint256(0xABCD));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_StellarHookLengthMismatch() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;
        // Declared strkey length (56) disagrees with the 10 trailing bytes present
        validCCTPData.hookData = abi.encodePacked(
            bytes24("cctp-forward"), uint32(0), uint32(56), new bytes(10)
        );
        validCCTPData.nonEVMReceiver = bytes32(uint256(0xABCD));

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Swap entrypoint
    // ---------------------------------------------------------------------

    function test_CanSwapAndBridgeWithForwardingHook() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;
        validCCTPData.maxCCTPFee = defaultUSDCAmount / 10;
        validCCTPData.hookData = _buildForwardingHookData();

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithZeroRefundRecipient() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;
        validCCTPData.refundRecipient = address(0);

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_SwapAndBridgeRefundsExcessNativeToRefundRecipient() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;
        validCCTPData.maxCCTPFee = defaultUSDCAmount / 10;

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        uint256 excessNative = 1 ether;
        vm.deal(USER_SENDER, excessNative);
        uint256 refundBalanceBefore = USER_REFUND.balance;

        cctpFacet.swapAndStartBridgeTokensViaCCTP{ value: excessNative }(
            bridgeData, swapData, validCCTPData
        );

        assertEq(USER_REFUND.balance, refundBalanceBefore + excessNative);

        vm.stopPrank();
    }

    function testRevert_SwapOutputNotUSDC() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;

        setDefaultSwapDataSingleDAItoUSDC();
        swapData[swapData.length - 1].receivingAssetId = ADDRESS_DAI;
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidSendingToken.selector);

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Chain ID to domain ID mappings
    // ---------------------------------------------------------------------

    function test_ChainIdToDomainIdMapping() public view {
        CCTPFacet.ChainIdConfig[] memory configs = _defaultChainIdConfigs();

        for (uint256 i = 0; i < configs.length; i++) {
            assertEq(
                cctpFacet.getCCTPChainIdToDomainId(configs[i].chainId),
                configs[i].domainId
            );
        }
    }

    function test_CanSetChainIdToDomainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        CCTPFacet.ChainIdConfig[] memory configs =
            new CCTPFacet.ChainIdConfig[](2);
        configs[0] =
            CCTPFacet.ChainIdConfig({ chainId: 5042002, domainId: 26 });
        configs[1] =
            CCTPFacet.ChainIdConfig({ chainId: 5042003, domainId: 27 });

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit CCTPChainIdToDomainIdSet(5042002, 26);

        cctpFacet.setCCTPChainIdToDomainId(configs);

        assertEq(cctpFacet.getCCTPChainIdToDomainId(5042002), 26);
        assertEq(cctpFacet.getCCTPChainIdToDomainId(5042003), 27);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToDomainIdFromNotOwner() public {
        vm.startPrank(USER_SENDER);

        CCTPFacet.ChainIdConfig[] memory configs =
            new CCTPFacet.ChainIdConfig[](1);
        configs[0] =
            CCTPFacet.ChainIdConfig({ chainId: 5042002, domainId: 26 });

        vm.expectRevert(OnlyContractOwner.selector);

        cctpFacet.setCCTPChainIdToDomainId(configs);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToDomainIdIfNotInitialized() public {
        TestCCTPFacet uninitializedFacet =
            _deployUninitializedFacetInNewDiamond();
        CCTPFacet.ChainIdConfig[] memory configs =
            new CCTPFacet.ChainIdConfig[](1);
        configs[0] = CCTPFacet.ChainIdConfig({ chainId: 5042, domainId: 26 });

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(NotInitialized.selector);

        uninitializedFacet.setCCTPChainIdToDomainId(configs);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToDomainIdWithEmptyConfig() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidConfig.selector);

        cctpFacet.setCCTPChainIdToDomainId(new CCTPFacet.ChainIdConfig[](0));

        vm.stopPrank();
    }

    function test_CanUnsetChainIdToDomainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        assertEq(cctpFacet.getCCTPChainIdToDomainId(8453), BASE_CCTP_DOMAIN);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit CCTPChainIdToDomainIdUnset(8453);

        cctpFacet.unsetCCTPChainIdToDomainId(8453);

        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 8453)
        );

        cctpFacet.getCCTPChainIdToDomainId(8453);

        vm.stopPrank();
    }

    function testRevert_UnsetChainIdToDomainIdFromNotOwner() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);

        cctpFacet.unsetCCTPChainIdToDomainId(8453);

        vm.stopPrank();
    }

    function testRevert_UnsetChainIdToDomainIdIfNotInitialized() public {
        TestCCTPFacet uninitializedFacet =
            _deployUninitializedFacetInNewDiamond();

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(NotInitialized.selector);

        uninitializedFacet.unsetCCTPChainIdToDomainId(8453);

        vm.stopPrank();
    }

    function testRevert_BridgeToUnsetChainId() public {
        vm.prank(USER_DIAMOND_OWNER);
        cctpFacet.unsetCCTPChainIdToDomainId(8453);

        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 8453)
        );

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_GetDomainIdForUnsupportedChainId() public {
        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 99999)
        );

        cctpFacet.getCCTPChainIdToDomainId(99999);
    }

    function test_InitCCTPSetsApprovalAndMappings() public {
        TestCCTPFacet facet = _deployUninitializedFacetInNewDiamond();
        CCTPFacet.ChainIdConfig[] memory configs = _defaultChainIdConfigs();

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(facet));
        emit CCTPChainMappingsInitialized(configs);

        facet.initCCTP(configs);

        assertEq(
            IERC20(ADDRESS_USDC)
                .allowance(address(facet), TOKEN_MESSENGER_V2_MAINNET),
            type(uint256).max
        );
        assertEq(facet.getCCTPChainIdToDomainId(1), 0);
        assertEq(facet.getCCTPChainIdToDomainId(1672), 31);

        vm.stopPrank();
    }

    function testRevert_InitCCTPFromNotOwner() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);

        cctpFacet.initCCTP(_defaultChainIdConfigs());

        vm.stopPrank();
    }

    function testRevert_InitCCTPWithEmptyConfig() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert(InvalidConfig.selector);

        cctpFacet.initCCTP(new CCTPFacet.ChainIdConfig[](0));

        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev The networks of config/cctp.json plus Solana, HyperCore and Stellar
    function _defaultChainIdConfigs()
        internal
        pure
        returns (CCTPFacet.ChainIdConfig[] memory configs)
    {
        configs = new CCTPFacet.ChainIdConfig[](11);
        configs[0] = CCTPFacet.ChainIdConfig({ chainId: 1, domainId: 0 }); // Ethereum
        configs[1] = CCTPFacet.ChainIdConfig({ chainId: 43114, domainId: 1 }); // Avalanche
        configs[2] = CCTPFacet.ChainIdConfig({ chainId: 10, domainId: 2 }); // OP Mainnet
        configs[3] = CCTPFacet.ChainIdConfig({ chainId: 42161, domainId: 3 }); // Arbitrum
        configs[4] = CCTPFacet.ChainIdConfig({
            chainId: LIFI_CHAIN_ID_SOLANA, domainId: SOLANA_CCTP_DOMAIN
        }); // Solana
        configs[5] = CCTPFacet.ChainIdConfig({
            chainId: 8453, domainId: BASE_CCTP_DOMAIN
        }); // Base
        configs[6] = CCTPFacet.ChainIdConfig({ chainId: 137, domainId: 7 }); // Polygon
        configs[7] = CCTPFacet.ChainIdConfig({ chainId: 146, domainId: 13 }); // Sonic
        configs[8] = CCTPFacet.ChainIdConfig({ chainId: 1672, domainId: 31 }); // Pharos
        configs[9] = CCTPFacet.ChainIdConfig({
            chainId: LIFI_CHAIN_ID_HYPERCORE, domainId: HYPEREVM_CCTP_DOMAIN
        }); // HyperCore (HyperEVM's domain)
        configs[10] = CCTPFacet.ChainIdConfig({
            chainId: LIFI_CHAIN_ID_STELLAR, domainId: STELLAR_CCTP_DOMAIN
        }); // Stellar
    }

    function _deployUninitializedFacetInNewDiamond()
        internal
        returns (TestCCTPFacet)
    {
        LiFiDiamond testDiamond =
            createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        TestCCTPFacet facet =
            new TestCCTPFacet(TOKEN_MESSENGER_V2_MAINNET, ADDRESS_USDC);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = facet.initCCTP.selector;
        functionSelectors[1] = facet.getCCTPChainIdToDomainId.selector;
        functionSelectors[2] = facet.setCCTPChainIdToDomainId.selector;
        functionSelectors[3] = facet.unsetCCTPChainIdToDomainId.selector;
        addFacet(testDiamond, address(facet), functionSelectors);

        return TestCCTPFacet(address(testDiamond));
    }

    function _setSolanaDestination() internal {
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validCCTPData.nonEVMReceiver = bytes32(uint256(0x1234));
        validCCTPData.solanaReceiverATA = bytes32(uint256(0x5678));
    }

    function _assertBridgesWithFinalityThreshold(uint32 _threshold) internal {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        validCCTPData.minFinalityThreshold = _threshold;

        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurn,
                (
                    bridgeData.minAmount,
                    BASE_CCTP_DOMAIN,
                    LibBytes.toBytes32(bridgeData.receiver),
                    ADDRESS_USDC,
                    bytes32(0),
                    validCCTPData.maxCCTPFee,
                    _threshold
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    /// @dev Circle Forwarding Service hook with no payload: magic (24) + version (4)
    ///      + payload length (4, = 0)
    function _buildForwardingHookData() internal pure returns (bytes memory) {
        return abi.encodePacked(bytes24("cctp-forward"), uint32(0), uint32(0));
    }

    /// @dev CctpForwarder hook data: magic (24) + version (4) + payload length (4)
    ///      + recipient (20) + destination dex (4, 0xFFFFFFFF = spot balance)
    function _buildHyperCoreHookData(address _recipient)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes24("cctp-forward"),
            uint32(0),
            uint32(24),
            _recipient,
            uint32(0xFFFFFFFF)
        );
    }

    /// @dev Stellar CctpForwarder hook data: magic (24) + version (4)
    ///      + strkey length L (4) + strkey (L)
    function _buildStellarHookData(bytes memory _strkey)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            bytes24("cctp-forward"), uint32(0), uint32(_strkey.length), _strkey
        );
    }
}
