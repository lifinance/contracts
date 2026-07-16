// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { PolymerCCTPFacet } from "lifi/Facets/PolymerCCTPFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LiFiDiamond } from "../utils/DiamondTest.sol";
import { InvalidCallData, InvalidConfig, InvalidReceiver, InvalidSendingToken, NotInitialized, OnlyContractOwner, UnsupportedChainId } from "lifi/Errors/GenericErrors.sol";
import { ITokenMessenger } from "lifi/Interfaces/ITokenMessenger.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Stub PolymerCCTPFacet Contract
contract TestPolymerCCTPFacet is PolymerCCTPFacet, TestWhitelistManagerBase {
    constructor(
        address _tokenMessenger,
        address _usdc,
        address _polymerFeeReceiver
    ) PolymerCCTPFacet(_tokenMessenger, _usdc, _polymerFeeReceiver) {}
}

contract PolymerCCTPFacetTest is TestBaseFacet {
    event PolymerCCTPFeeSent(
        uint256 bridgeAmount,
        uint256 polymerFee,
        uint32 minFinalityThreshold
    );

    event PolymerCCTPChainMappingsInitialized(
        PolymerCCTPFacet.ChainIdConfig[] chainIdConfigs
    );

    event ChainIdToDomainIdSet(uint256 indexed chainId, uint32 domainId);

    event ChainIdToDomainIdUnset(uint256 indexed chainId);

    TestPolymerCCTPFacet internal polymerCCTPFacet;
    address internal constant TOKEN_MESSENGER_V2_MAINNET =
        0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    // Must match PolymerCCTPFacet.HYPERCORE_CCTP_FORWARDER
    bytes32 internal constant HYPERCORE_CCTP_FORWARDER =
        bytes32(uint256(uint160(0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757)));
    uint32 internal constant HYPEREVM_CCTP_DOMAIN = 19;
    // Must match PolymerCCTPFacet.STELLAR_CCTP_FORWARDER (Stellar mainnet CctpForwarder)
    bytes32 internal constant STELLAR_CCTP_FORWARDER =
        0x72bd20ff2f8281801bb05b7c29179026933256fabafeb13e94efd8ddbcfcf291;
    uint32 internal constant STELLAR_CCTP_DOMAIN = 27;
    address internal polymerFeeReceiver = address(0x123);

    PolymerCCTPFacet.PolymerCCTPData internal validPolymerData;

    struct ChainMapping {
        uint256 chainId;
        uint32 domainId;
    }

    function _defaultChainMappings()
        internal
        pure
        returns (ChainMapping[] memory mappings)
    {
        mappings = new ChainMapping[](22);
        mappings[0] = ChainMapping({ chainId: 1, domainId: 0 }); // Ethereum
        mappings[1] = ChainMapping({ chainId: 43114, domainId: 1 }); // Avalanche
        mappings[2] = ChainMapping({ chainId: 10, domainId: 2 }); // OP Mainnet
        mappings[3] = ChainMapping({ chainId: 42161, domainId: 3 }); // Arbitrum
        mappings[4] = ChainMapping({ chainId: 1151111081099710, domainId: 5 }); // Solana
        mappings[5] = ChainMapping({ chainId: 8453, domainId: 6 }); // Base
        mappings[6] = ChainMapping({ chainId: 137, domainId: 7 }); // Polygon
        mappings[7] = ChainMapping({ chainId: 130, domainId: 10 }); // Unichain
        mappings[8] = ChainMapping({ chainId: 59144, domainId: 11 }); // Linea
        mappings[9] = ChainMapping({ chainId: 81224, domainId: 12 }); // Codex
        mappings[10] = ChainMapping({ chainId: 146, domainId: 13 }); // Sonic
        mappings[11] = ChainMapping({ chainId: 480, domainId: 14 }); // World Chain
        mappings[12] = ChainMapping({ chainId: 143, domainId: 15 }); // Monad
        mappings[13] = ChainMapping({ chainId: 1329, domainId: 16 }); // Sei
        mappings[14] = ChainMapping({ chainId: 50, domainId: 18 }); // XDC
        mappings[15] = ChainMapping({ chainId: 999, domainId: 19 }); // HyperEVM
        mappings[16] = ChainMapping({ chainId: 57073, domainId: 21 }); // Ink
        mappings[17] = ChainMapping({ chainId: 98866, domainId: 22 }); // Plume
        mappings[18] = ChainMapping({ chainId: 5042, domainId: 26 }); // Arc
        mappings[19] = ChainMapping({ chainId: 1672, domainId: 31 }); // Pharos
        mappings[20] = ChainMapping({
            chainId: LIFI_CHAIN_ID_HYPERCORE,
            domainId: 19
        }); // HyperCore (same CCTP domain as HyperEVM)
        mappings[21] = ChainMapping({
            chainId: LIFI_CHAIN_ID_STELLAR,
            domainId: STELLAR_CCTP_DOMAIN
        }); // Stellar
    }

    function _toChainIdConfigs(
        ChainMapping[] memory mappings
    ) internal pure returns (PolymerCCTPFacet.ChainIdConfig[] memory) {
        PolymerCCTPFacet.ChainIdConfig[]
            memory configs = new PolymerCCTPFacet.ChainIdConfig[](
                mappings.length
            );

        for (uint256 i = 0; i < mappings.length; i++) {
            configs[i] = PolymerCCTPFacet.ChainIdConfig({
                chainId: mappings[i].chainId,
                domainId: mappings[i].domainId
            });
        }

        return configs;
    }

    function _initPolymerCCTP() internal {
        polymerCCTPFacet.initPolymerCCTP(
            _toChainIdConfigs(_defaultChainMappings())
        );
    }

    function setUp() public {
        customBlockNumberForForking = 23767209;
        initTestBase();

        polymerCCTPFacet = new TestPolymerCCTPFacet(
            TOKEN_MESSENGER_V2_MAINNET,
            ADDRESS_USDC,
            polymerFeeReceiver
        );

        bytes4[] memory functionSelectors = new bytes4[](7);
        functionSelectors[0] = polymerCCTPFacet
            .startBridgeTokensViaPolymerCCTP
            .selector;
        functionSelectors[1] = polymerCCTPFacet
            .swapAndStartBridgeTokensViaPolymerCCTP
            .selector;
        functionSelectors[2] = polymerCCTPFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = polymerCCTPFacet.getChainIdToDomainId.selector;
        functionSelectors[4] = polymerCCTPFacet.initPolymerCCTP.selector;
        functionSelectors[5] = polymerCCTPFacet.setChainIdToDomainId.selector;
        functionSelectors[6] = polymerCCTPFacet
            .unsetChainIdToDomainId
            .selector;

        addFacet(diamond, address(polymerCCTPFacet), functionSelectors);
        polymerCCTPFacet = TestPolymerCCTPFacet(address(diamond));
        vm.startPrank(USER_DIAMOND_OWNER);
        _initPolymerCCTP();
        vm.stopPrank();

        polymerCCTPFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );

        setFacetAddressInTestBase(
            address(polymerCCTPFacet),
            "PolymerCCTPFacet"
        );

        bridgeData.bridge = "polymercctp";
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = 1000 * 10 ** usdc.decimals();
        bridgeData.destinationChainId = 8453; // Base

        validPolymerData = PolymerCCTPFacet.PolymerCCTPData({
            polymerTokenFee: (bridgeData.minAmount / 100) * 1, // 1% of bridging amount
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
        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            validPolymerData
        );
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        polymerCCTPFacet.swapAndStartBridgeTokensViaPolymerCCTP(
            bridgeData,
            swapData,
            validPolymerData
        );
    }

    // Helper function to create BridgeData with adjusted minAmount (after polymer fee deduction)
    function getBridgeDataWithAdjustedAmount()
        internal
        view
        returns (ILiFi.BridgeData memory)
    {
        ILiFi.BridgeData memory adjustedBridgeData = bridgeData;
        adjustedBridgeData.minAmount =
            bridgeData.minAmount -
            validPolymerData.polymerTokenFee;
        return adjustedBridgeData;
    }

    // Disable base tests that use native tokens or tokens other than USDC
    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support native bridging
    }

    function testBase_CanBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        ILiFi.BridgeData
            memory adjustedBridgeData = getBridgeDataWithAdjustedAmount();
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.startPrank(USER_SENDER);

        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        // Recalculate polymer fee as 1% of the fuzzed amount
        uint256 polymerFee = amount / 100;
        // Recalculate maxCCTPFee as 10% of the fuzzed amount (or 0 for no limit)
        uint256 maxCCTPFee = amount / 10;
        PolymerCCTPFacet.PolymerCCTPData
            memory fuzzedPolymerData = PolymerCCTPFacet.PolymerCCTPData({
                polymerTokenFee: polymerFee,
                maxCCTPFee: maxCCTPFee,
                nonEVMReceiver: validPolymerData.nonEVMReceiver,
                solanaReceiverATA: validPolymerData.solanaReceiverATA,
                minFinalityThreshold: validPolymerData.minFinalityThreshold,
                refundRecipient: validPolymerData.refundRecipient,
                hookData: validPolymerData.hookData
            });

        usdc.approve(_facetTestContractAddress, amount);

        ILiFi.BridgeData memory adjustedBridgeData = bridgeData;
        adjustedBridgeData.minAmount = amount - polymerFee;
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        // Use the fuzzed polymer data instead of the default
        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            fuzzedPolymerData
        );
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;

        // Set minAmount to match what the swap will produce (defaultUSDCAmount = 100 USDC)
        bridgeData.minAmount = defaultUSDCAmount;

        setDefaultSwapDataSingleDAItoUSDC();

        // Recalculate polymer fee as 1% of the swap output amount
        uint256 swapOutputAmount = defaultUSDCAmount;
        uint256 polymerFee = swapOutputAmount / 100;
        PolymerCCTPFacet.PolymerCCTPData
            memory swapPolymerData = PolymerCCTPFacet.PolymerCCTPData({
                polymerTokenFee: polymerFee,
                maxCCTPFee: swapOutputAmount / 10, // 10% of swap output
                nonEVMReceiver: validPolymerData.nonEVMReceiver,
                solanaReceiverATA: validPolymerData.solanaReceiverATA,
                minFinalityThreshold: validPolymerData.minFinalityThreshold,
                refundRecipient: validPolymerData.refundRecipient,
                hookData: validPolymerData.hookData
            });

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            swapOutputAmount,
            block.timestamp
        );

        ILiFi.BridgeData memory adjustedBridgeData = bridgeData;
        adjustedBridgeData.minAmount = swapOutputAmount - polymerFee;
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        // Use the swap-specific polymer data
        polymerCCTPFacet.swapAndStartBridgeTokensViaPolymerCCTP(
            bridgeData,
            swapData,
            swapPolymerData
        );
        vm.stopPrank();
    }

    function testBase_Revert_BridgeWithInvalidReceiverAddress()
        public
        override
    {
        // Receiver validation happens after transfer, but with approval we get InvalidReceiver
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
        // Set minAmount to match what the swap will produce (defaultUSDCAmount = 100 USDC)
        bridgeData.minAmount = defaultUSDCAmount;

        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidReceiver.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_ConstructorWithZeroTokenMessenger() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestPolymerCCTPFacet(address(0), ADDRESS_USDC, polymerFeeReceiver);
    }

    function testRevert_ConstructorWithZeroUSDC() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestPolymerCCTPFacet(
            TOKEN_MESSENGER_V2_MAINNET,
            address(0),
            polymerFeeReceiver
        );
    }

    function testRevert_ConstructorWithZeroFeeReceiver() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestPolymerCCTPFacet(
            TOKEN_MESSENGER_V2_MAINNET,
            ADDRESS_USDC,
            address(0)
        );
    }

    function testRevert_InvalidSendingToken() public {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = ADDRESS_DAI;
        dai.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidSendingToken.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeToNonEVMChain() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validPolymerData.nonEVMReceiver = bytes32(uint256(0x1234));
        validPolymerData.solanaReceiverATA = bytes32(uint256(0x5678));

        // For Solana the event carries the actual mint target (the ATA), not nonEVMReceiver,
        // so the emitted receiver can never diverge from where the USDC is minted.
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit ILiFi.BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            validPolymerData.solanaReceiverATA
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFeeSent(
            bridgeData.minAmount,
            validPolymerData.polymerTokenFee,
            validPolymerData.minFinalityThreshold
        );

        ILiFi.BridgeData
            memory adjustedBridgeData = getBridgeDataWithAdjustedAmount();
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeToHyperCoreWithHookData() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildHyperCoreHookData(bridgeData.receiver)
            );

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        uint256 bridgeAmount = bridgeData.minAmount -
            polymerDataWithHook.polymerTokenFee;
        vm.expectCall(
            TOKEN_MESSENGER_V2_MAINNET,
            abi.encodeCall(
                ITokenMessenger.depositForBurnWithHook,
                (
                    bridgeAmount,
                    HYPEREVM_CCTP_DOMAIN,
                    HYPERCORE_CCTP_FORWARDER,
                    ADDRESS_USDC,
                    HYPERCORE_CCTP_FORWARDER,
                    polymerDataWithHook.maxCCTPFee,
                    polymerDataWithHook.minFinalityThreshold,
                    polymerDataWithHook.hookData
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFeeSent(
            bridgeData.minAmount,
            polymerDataWithHook.polymerTokenFee,
            polymerDataWithHook.minFinalityThreshold
        );

        ILiFi.BridgeData memory adjustedBridgeData = bridgeData;
        adjustedBridgeData.minAmount = bridgeAmount;
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_HookDataToNonHyperCoreDestination() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // destinationChainId stays Base (8453) from setUp
        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildHyperCoreHookData(bridgeData.receiver)
            );

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_HookDataToNonEVMDestination() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;

        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildHyperCoreHookData(USER_RECEIVER)
            );
        polymerDataWithHook.nonEVMReceiver = bytes32(uint256(0x1234));
        polymerDataWithHook.solanaReceiverATA = bytes32(uint256(0x5678));

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_HyperCoreWithNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildHyperCoreHookData(USER_RECEIVER)
            );
        polymerDataWithHook.nonEVMReceiver = bytes32(uint256(0x1234));

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_HyperCoreWithoutHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            validPolymerData
        );

        vm.stopPrank();
    }

    function testRevert_HyperCoreHookReceiverMismatch() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildHyperCoreHookData(address(0xDEADBEEF))
            );

        vm.expectRevert(InvalidReceiver.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_HyperCoreHookDataTooShort() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(hex"01");

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_HyperCoreHookDataBelowMinLength() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        // 51 bytes: one below the minimum that contains a full recipient
        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(new bytes(51));

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function test_CanBridgeToHyperCoreWithMinimalHookData() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_HYPERCORE;

        // Exactly 52 bytes: header + recipient, no destinationId
        bytes memory hookData = abi.encodePacked(
            bytes24("cctp-forward"),
            uint32(0),
            uint32(20),
            bridgeData.receiver
        );
        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(hookData);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFeeSent(
            bridgeData.minAmount,
            polymerDataWithHook.polymerTokenFee,
            polymerDataWithHook.minFinalityThreshold
        );

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    /// @dev CctpForwarder hook data: magic (24) + version (4) + payload length (4)
    ///      + recipient (20) + destination dex (4, 0xFFFFFFFF = spot balance)
    function _buildHyperCoreHookData(
        address recipient
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                bytes24("cctp-forward"),
                uint32(0),
                uint32(24),
                recipient,
                uint32(0xFFFFFFFF)
            );
    }

    /// @dev Stellar CctpForwarder hook data: magic (24) + version (4)
    ///      + strkey length L (4) + strkey (L). The length field must equal the
    ///      actual strkey length or the facet rejects the hook.
    function _buildStellarHookData(
        bytes memory strkey
    ) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                bytes24("cctp-forward"),
                uint32(0),
                uint32(strkey.length),
                strkey
            );
    }

    function _polymerDataWithHook(
        bytes memory hookData
    ) internal view returns (PolymerCCTPFacet.PolymerCCTPData memory) {
        return
            PolymerCCTPFacet.PolymerCCTPData({
                polymerTokenFee: validPolymerData.polymerTokenFee,
                maxCCTPFee: validPolymerData.maxCCTPFee,
                nonEVMReceiver: validPolymerData.nonEVMReceiver,
                solanaReceiverATA: validPolymerData.solanaReceiverATA,
                minFinalityThreshold: validPolymerData.minFinalityThreshold,
                refundRecipient: validPolymerData.refundRecipient,
                hookData: hookData
            });
    }

    function test_CanBridgeToStellarWithHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;

        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildStellarHookData(
                    bytes(
                        "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX"
                    )
                )
            );
        polymerDataWithHook.nonEVMReceiver = bytes32(uint256(0xABCD));

        uint256 bridgeAmount = bridgeData.minAmount -
            polymerDataWithHook.polymerTokenFee;

        // Stellar (CCTP domain 27) is not yet registered on the forked mainnet
        // TokenMessengerV2, so mock the burn to isolate the facet's dispatch/calldata.
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
                    bridgeAmount,
                    STELLAR_CCTP_DOMAIN,
                    STELLAR_CCTP_FORWARDER,
                    ADDRESS_USDC,
                    STELLAR_CCTP_FORWARDER,
                    polymerDataWithHook.maxCCTPFee,
                    polymerDataWithHook.minFinalityThreshold,
                    polymerDataWithHook.hookData
                )
            )
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit ILiFi.BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_STELLAR,
            polymerDataWithHook.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFeeSent(
            bridgeData.minAmount,
            polymerDataWithHook.polymerTokenFee,
            polymerDataWithHook.minFinalityThreshold
        );

        ILiFi.BridgeData memory adjustedBridgeData = bridgeData;
        adjustedBridgeData.minAmount = bridgeAmount;
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_StellarWithEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // receiver left as the default EVM address instead of NON_EVM_ADDRESS
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;

        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildStellarHookData(
                    bytes(
                        "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX"
                    )
                )
            );
        polymerDataWithHook.nonEVMReceiver = bytes32(uint256(0xABCD));

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_StellarWithoutNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;

        // nonEVMReceiver left as zero
        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(
                _buildStellarHookData(
                    bytes(
                        "GDUKMGUGDZQK6YHYA5Z6AY2G4XDSZPSZ3SW5UN3ARVMO6QSRDWP5YLEX"
                    )
                )
            );

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_StellarWithoutHookData() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;
        validPolymerData.nonEVMReceiver = bytes32(uint256(0xABCD));

        // validPolymerData.hookData is empty -> length 0 < 32
        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_StellarHookDataTooShort() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;

        // 31 bytes: one below the 32-byte header holding the length field
        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(new bytes(31));
        polymerDataWithHook.nonEVMReceiver = bytes32(uint256(0xABCD));

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_StellarHookLengthMismatch() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_STELLAR;

        // Declared strkey length (56) disagrees with the 10 trailing bytes present
        bytes memory badHook = abi.encodePacked(
            bytes24("cctp-forward"),
            uint32(0),
            uint32(56),
            new bytes(10)
        );
        PolymerCCTPFacet.PolymerCCTPData
            memory polymerDataWithHook = _polymerDataWithHook(badHook);
        polymerDataWithHook.nonEVMReceiver = bytes32(uint256(0xABCD));

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.startBridgeTokensViaPolymerCCTP(
            bridgeData,
            polymerDataWithHook
        );

        vm.stopPrank();
    }

    function testRevert_SentinelReceiverToEVMDestination() public {
        // Finding #1: the NON_EVM_ADDRESS sentinel toward an EVM chain must revert. Otherwise
        // CCTP would mint to the low 20 bytes of nonEVMReceiver while events still show the
        // sentinel, hiding the real recipient from any clear-signing display.
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = 8453; // Base (EVM)
        validPolymerData.nonEVMReceiver = bytes32(
            uint256(uint160(address(0xBEEF)))
        );

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_EVMReceiverToSolanaDestination() public {
        // Finding #4: a real EVM receiver toward a genuinely non-EVM chain (Solana) must
        // revert instead of burning a zero-padded EVM address to Solana's domain, where it
        // is not a valid account and the USDC becomes unclaimable.
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // receiver left as the default EVM address; destination is Solana
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validPolymerData.solanaReceiverATA = bytes32(uint256(0x5678));

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_SolanaDestinationWithZeroSolanaReceiverATA() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validPolymerData.nonEVMReceiver = bytes32(uint256(0x1234));
        validPolymerData.solanaReceiverATA = bytes32(0);

        vm.expectRevert(InvalidConfig.selector);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeWithFastRoute() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPolymerData.minFinalityThreshold = 1000; // Fast route (1000)

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFeeSent(
            bridgeData.minAmount,
            validPolymerData.polymerTokenFee,
            validPolymerData.minFinalityThreshold
        );

        ILiFi.BridgeData
            memory adjustedBridgeData = getBridgeDataWithAdjustedAmount();
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeWithStandardRoute() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPolymerData.minFinalityThreshold = 2000; // Standard route (2000)

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFeeSent(
            bridgeData.minAmount,
            validPolymerData.polymerTokenFee,
            validPolymerData.minFinalityThreshold
        );

        ILiFi.BridgeData
            memory adjustedBridgeData = getBridgeDataWithAdjustedAmount();
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_ChainIdToDomainIdMapping() public {
        ChainMapping[] memory mappings = _defaultChainMappings();

        for (uint256 i = 0; i < mappings.length; i++) {
            assertEq(
                polymerCCTPFacet.getChainIdToDomainId(mappings[i].chainId),
                mappings[i].domainId
            );
        }
    }

    function test_CanSetChainIdToDomainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        uint256 chainId = 5042002;
        uint32 domainId = 26;

        PolymerCCTPFacet.ChainIdConfig[]
            memory chainIdConfigs = new PolymerCCTPFacet.ChainIdConfig[](1);
        chainIdConfigs[0] = PolymerCCTPFacet.ChainIdConfig({
            chainId: chainId,
            domainId: domainId
        });

        vm.expectEmit(true, true, true, true);
        emit ChainIdToDomainIdSet(chainId, domainId);

        polymerCCTPFacet.setChainIdToDomainId(chainIdConfigs);

        assertEq(polymerCCTPFacet.getChainIdToDomainId(chainId), domainId);

        vm.stopPrank();
    }

    function test_CanSetMultipleChainIdsToDomainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        PolymerCCTPFacet.ChainIdConfig[]
            memory chainIdConfigs = new PolymerCCTPFacet.ChainIdConfig[](2);
        chainIdConfigs[0] = PolymerCCTPFacet.ChainIdConfig({
            chainId: 5042002,
            domainId: 26
        });
        chainIdConfigs[1] = PolymerCCTPFacet.ChainIdConfig({
            chainId: 5042003,
            domainId: 27
        });

        polymerCCTPFacet.setChainIdToDomainId(chainIdConfigs);

        assertEq(polymerCCTPFacet.getChainIdToDomainId(5042002), 26);
        assertEq(polymerCCTPFacet.getChainIdToDomainId(5042003), 27);

        vm.stopPrank();
    }

    function testRevert_FailToSetChainIdToDomainIdFromNotOwner() public {
        vm.startPrank(USER_SENDER);

        PolymerCCTPFacet.ChainIdConfig[]
            memory chainIdConfigs = new PolymerCCTPFacet.ChainIdConfig[](1);
        chainIdConfigs[0] = PolymerCCTPFacet.ChainIdConfig({
            chainId: 5042002,
            domainId: 26
        });

        vm.expectRevert(OnlyContractOwner.selector);

        polymerCCTPFacet.setChainIdToDomainId(chainIdConfigs);

        vm.stopPrank();
    }

    function testRevert_FailsToSetChainIdToDomainIdIfNotInitialized() public {
        vm.startPrank(address(0));

        TestPolymerCCTPFacet uninitializedFacet = new TestPolymerCCTPFacet(
            TOKEN_MESSENGER_V2_MAINNET,
            ADDRESS_USDC,
            polymerFeeReceiver
        );

        PolymerCCTPFacet.ChainIdConfig[]
            memory chainIdConfigs = new PolymerCCTPFacet.ChainIdConfig[](1);
        chainIdConfigs[0] = PolymerCCTPFacet.ChainIdConfig({
            chainId: 5042,
            domainId: 26
        });

        vm.expectRevert(NotInitialized.selector);

        uninitializedFacet.setChainIdToDomainId(chainIdConfigs);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToDomainIdWithEmptyConfig() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        PolymerCCTPFacet.ChainIdConfig[]
            memory chainIdConfigs = new PolymerCCTPFacet.ChainIdConfig[](0);

        vm.expectRevert(InvalidConfig.selector);

        polymerCCTPFacet.setChainIdToDomainId(chainIdConfigs);

        vm.stopPrank();
    }

    function test_CanUnsetChainIdToDomainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        uint256 chainId = 8453;

        assertEq(polymerCCTPFacet.getChainIdToDomainId(chainId), 6);

        vm.expectEmit(true, true, true, true);
        emit ChainIdToDomainIdUnset(chainId);

        polymerCCTPFacet.unsetChainIdToDomainId(chainId);

        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, chainId)
        );

        polymerCCTPFacet.getChainIdToDomainId(chainId);

        vm.stopPrank();
    }

    function testRevert_FailToUnsetChainIdToDomainIdFromNotOwner() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);

        polymerCCTPFacet.unsetChainIdToDomainId(8453);

        vm.stopPrank();
    }

    function testRevert_FailsToUnsetChainIdToDomainIdIfNotInitialized()
        public
    {
        vm.startPrank(address(0));

        TestPolymerCCTPFacet uninitializedFacet = new TestPolymerCCTPFacet(
            TOKEN_MESSENGER_V2_MAINNET,
            ADDRESS_USDC,
            polymerFeeReceiver
        );

        vm.expectRevert(NotInitialized.selector);

        uninitializedFacet.unsetChainIdToDomainId(8453);

        vm.stopPrank();
    }

    function testRevert_BridgeToUnsetChainIdReverts() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        polymerCCTPFacet.unsetChainIdToDomainId(8453);

        vm.stopPrank();

        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 8453)
        );

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function testRevert_ChainIdToDomainIdWithUnsupportedChainId() public {
        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 99999)
        );

        polymerCCTPFacet.getChainIdToDomainId(99999);
    }

    function test_InitPolymerCCTP() public {
        LiFiDiamond testDiamond = createDiamond(
            USER_DIAMOND_OWNER,
            USER_PAUSER
        );

        PolymerCCTPFacet actualFacet = new PolymerCCTPFacet(
            TOKEN_MESSENGER_V2_MAINNET,
            ADDRESS_USDC,
            polymerFeeReceiver
        );

        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = actualFacet.initPolymerCCTP.selector;
        functionSelectors[1] = actualFacet.getChainIdToDomainId.selector;
        addFacet(testDiamond, address(actualFacet), functionSelectors);

        PolymerCCTPFacet.ChainIdConfig[]
            memory chainIdConfigs = _toChainIdConfigs(_defaultChainMappings());

        vm.startPrank(USER_DIAMOND_OWNER);
        PolymerCCTPFacet(address(testDiamond)).initPolymerCCTP(chainIdConfigs);

        assertEq(
            IERC20(ADDRESS_USDC).allowance(
                address(testDiamond),
                TOKEN_MESSENGER_V2_MAINNET
            ),
            type(uint256).max
        );
        assertEq(
            PolymerCCTPFacet(address(testDiamond)).getChainIdToDomainId(1),
            0
        );
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeUSDC() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        uint256[] memory amounts = uniswap.getAmountsIn(
            bridgeData.minAmount,
            path
        );
        uint256 amountIn = amounts[0];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    bridgeData.minAmount,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        dai.approve(_facetTestContractAddress, amountIn);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            amountIn,
            bridgeData.minAmount,
            block.timestamp
        );

        ILiFi.BridgeData
            memory adjustedBridgeData = getBridgeDataWithAdjustedAmount();
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(adjustedBridgeData);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_SwapAndBridgeWithZeroRefundRecipient() public {
        // Finding #2: the swap entrypoint refunds swap leftovers and excess native. A zero
        // refundRecipient would strand them (e.g. in the Permit2Proxy), so the entrypoint
        // rejects it up front instead of failing late inside refundExcessNative.
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        PolymerCCTPFacet.PolymerCCTPData
            memory zeroRefundData = _polymerDataWithHook("");
        zeroRefundData.refundRecipient = address(0);

        vm.expectRevert(InvalidCallData.selector);

        polymerCCTPFacet.swapAndStartBridgeTokensViaPolymerCCTP(
            bridgeData,
            swapData,
            zeroRefundData
        );

        vm.stopPrank();
    }

    function test_SwapAndBridge_ExcessNativeRefundedToRefundRecipient()
        public
    {
        // Finding #2: excess native is refunded to refundRecipient, not msg.sender (which
        // may be a relayer or the Permit2Proxy).
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultUSDCAmount;

        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        uint256 swapOutputAmount = defaultUSDCAmount;
        PolymerCCTPFacet.PolymerCCTPData
            memory swapPolymerData = PolymerCCTPFacet.PolymerCCTPData({
                polymerTokenFee: swapOutputAmount / 100,
                maxCCTPFee: swapOutputAmount / 10,
                nonEVMReceiver: bytes32(0),
                solanaReceiverATA: bytes32(0),
                minFinalityThreshold: validPolymerData.minFinalityThreshold,
                refundRecipient: USER_REFUND,
                hookData: ""
            });

        uint256 excessNative = 1 ether;
        vm.deal(USER_SENDER, excessNative);
        uint256 refundBalanceBefore = USER_REFUND.balance;

        polymerCCTPFacet.swapAndStartBridgeTokensViaPolymerCCTP{
            value: excessNative
        }(bridgeData, swapData, swapPolymerData);

        assertEq(USER_REFUND.balance, refundBalanceBefore + excessNative);

        vm.stopPrank();
    }
}
