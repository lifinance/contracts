// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { PolymerCCTPFacet } from "lifi/Facets/PolymerCCTPFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LiFiDiamond } from "../utils/DiamondTest.sol";
import { InvalidConfig, InvalidReceiver, InvalidSendingToken, InvalidCallData } from "lifi/Errors/GenericErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

// Stub PolymerCCTPFacet Contract
contract TestPolymerCCTPFacet is PolymerCCTPFacet, TestWhitelistManagerBase {
    constructor(
        address _tokenMessenger,
        address _usdc,
        address _polymerFeeReceiver
    ) PolymerCCTPFacet(_tokenMessenger, _usdc, _polymerFeeReceiver) {}

    // Expose internal function for testing
    function chainIdToDomainId(
        uint256 chainId
    ) external pure returns (uint32) {
        return _chainIdToDomainId(chainId);
    }
}

contract PolymerCCTPFacetTest is TestBaseFacet {
    TestPolymerCCTPFacet internal polymerCCTPFacet;
    address internal constant TOKEN_MESSENGER_MAINNET =
        0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d;
    address internal polymerFeeReceiver = address(0x123);

    PolymerCCTPFacet.PolymerCCTPData internal validPolymerData;

    struct ChainMapping {
        uint256 chainId;
        uint32 domainId;
    }

    function setUp() public {
        customBlockNumberForForking = 23767209;
        initTestBase();

        polymerCCTPFacet = new TestPolymerCCTPFacet(
            TOKEN_MESSENGER_MAINNET,
            ADDRESS_USDC,
            polymerFeeReceiver
        );

        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = polymerCCTPFacet
            .startBridgeTokensViaPolymerCCTP
            .selector;
        functionSelectors[1] = polymerCCTPFacet
            .swapAndStartBridgeTokensViaPolymerCCTP
            .selector;
        functionSelectors[2] = polymerCCTPFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = polymerCCTPFacet.chainIdToDomainId.selector;
        functionSelectors[4] = polymerCCTPFacet.initPolymerCCTP.selector;

        addFacet(diamond, address(polymerCCTPFacet), functionSelectors);
        polymerCCTPFacet = TestPolymerCCTPFacet(address(diamond));
        // Initialize to set max approval (call as owner)
        vm.startPrank(USER_DIAMOND_OWNER);
        polymerCCTPFacet.initPolymerCCTP();
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
            minFinalityThreshold: 1000 // Fast route (1000)
        });

        assertEq(
            usdc.allowance(address(diamond), TOKEN_MESSENGER_MAINNET),
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
                minFinalityThreshold: validPolymerData.minFinalityThreshold
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
                minFinalityThreshold: validPolymerData.minFinalityThreshold
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
            TOKEN_MESSENGER_MAINNET,
            address(0),
            polymerFeeReceiver
        );
    }

    function testRevert_ConstructorWithZeroFeeReceiver() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestPolymerCCTPFacet(
            TOKEN_MESSENGER_MAINNET,
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

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit ILiFi.BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            validPolymerData.nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFacet.PolymerCCTPFeeSent(
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

    function testRevert_NonEVMReceiverWithZeroBytes32() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validPolymerData.nonEVMReceiver = bytes32(0);

        vm.expectRevert(InvalidReceiver.selector);
        initiateBridgeTxWithFacet(false);

        vm.stopPrank();
    }

    function test_CanBridgeWithFastRoute() public {
        vm.startPrank(USER_SENDER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPolymerData.minFinalityThreshold = 1000; // Fast route (1000)

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit PolymerCCTPFacet.PolymerCCTPFeeSent(
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
        emit PolymerCCTPFacet.PolymerCCTPFeeSent(
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
        ChainMapping[] memory mappings = new ChainMapping[](20);
        mappings[0] = ChainMapping({ chainId: 1, domainId: 0 }); // Ethereum
        mappings[1] = ChainMapping({ chainId: 43114, domainId: 1 }); // Avalanche
        mappings[2] = ChainMapping({ chainId: 10, domainId: 2 }); // OP Mainnet
        mappings[3] = ChainMapping({ chainId: 42161, domainId: 3 }); // Arbitrum
        mappings[4] = ChainMapping({ chainId: 8453, domainId: 6 }); // Base
        mappings[5] = ChainMapping({ chainId: 137, domainId: 7 }); // Polygon
        mappings[6] = ChainMapping({ chainId: 130, domainId: 10 }); // Unichain
        mappings[7] = ChainMapping({ chainId: 59144, domainId: 11 }); // Linea
        mappings[8] = ChainMapping({ chainId: 81224, domainId: 12 }); // Codex
        mappings[9] = ChainMapping({ chainId: 146, domainId: 13 }); // Sonic
        mappings[10] = ChainMapping({ chainId: 480, domainId: 14 }); // World Chain
        mappings[11] = ChainMapping({ chainId: 1329, domainId: 16 }); // Sei
        mappings[12] = ChainMapping({ chainId: 56, domainId: 17 }); // BNB Smart Chain
        mappings[13] = ChainMapping({ chainId: 50, domainId: 18 }); // XDC
        mappings[14] = ChainMapping({ chainId: 999, domainId: 19 }); // HyperEVM
        mappings[15] = ChainMapping({ chainId: 57073, domainId: 21 }); // Ink
        mappings[16] = ChainMapping({ chainId: 98866, domainId: 22 }); // Plume
        mappings[17] = ChainMapping({ chainId: 11155111, domainId: 0 }); // Sepolia
        mappings[18] = ChainMapping({ chainId: 11155420, domainId: 2 }); // OP Sepolia
        mappings[19] = ChainMapping({ chainId: 84532, domainId: 6 }); // Base Sepolia

        for (uint256 i = 0; i < mappings.length; i++) {
            assertEq(
                polymerCCTPFacet.chainIdToDomainId(mappings[i].chainId),
                mappings[i].domainId
            );
        }
    }

    function testRevert_ChainIdToDomainIdWithUnsupportedChainId() public {
        vm.expectRevert(InvalidCallData.selector);
        polymerCCTPFacet.chainIdToDomainId(99999); // Unsupported chainId
    }

    function test_InitPolymerCCTP() public {
        // Test the actual initPolymerCCTP function (not the overridden version)
        // Create a new diamond with the actual PolymerCCTPFacet to test owner check
        LiFiDiamond testDiamond = createDiamond(
            USER_DIAMOND_OWNER,
            USER_PAUSER
        );

        // Create actual facet (not the test version)
        PolymerCCTPFacet actualFacet = new PolymerCCTPFacet(
            TOKEN_MESSENGER_MAINNET,
            ADDRESS_USDC,
            polymerFeeReceiver
        );

        // Add it to the test diamond
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = actualFacet.initPolymerCCTP.selector;
        addFacet(testDiamond, address(actualFacet), functionSelectors);

        // Test as owner
        vm.startPrank(USER_DIAMOND_OWNER);
        PolymerCCTPFacet(address(testDiamond)).initPolymerCCTP();

        // Verify approval was set
        assertEq(
            IERC20(ADDRESS_USDC).allowance(
                address(testDiamond),
                TOKEN_MESSENGER_MAINNET
            ),
            type(uint256).max
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
}
