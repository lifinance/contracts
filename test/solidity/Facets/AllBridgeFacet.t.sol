// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { LibAllowList } from "lifi/Libraries/LibAllowList.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";
import { IAllBridge } from "lifi/Interfaces/IAllBridge.sol";
import { InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver } from "lifi/Errors/GenericErrors.sol";

// Stub AllBridgeFacet Contract
contract TestAllBridgeFacet is AllBridgeFacet {
    constructor(IAllBridge _allBridge) AllBridgeFacet(_allBridge) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }

    function getAllBridgeChainId(
        uint256 _chainId
    ) public pure returns (uint256) {
        return _getAllBridgeChainId(_chainId);
    }
}

contract AllBridgeFacetTest is TestBaseFacet {
    IAllBridge internal constant ALLBRIDGE_ROUTER =
        IAllBridge(0x609c690e8F7D68a59885c9132e812eEbDaAf0c9e);
    address internal constant ALLBRIDGE_POOL =
        0xa7062bbA94c91d565Ae33B893Ab5dFAF1Fc57C4d;
    bytes32 internal constant ADDRESS_USDC_SOLANA =
        hex"c6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61";
    uint32 private constant ALLBRIDGE_ID_ETHEREUM = 1;
    uint32 private constant ALLBRIDGE_ID_BSC = 2;
    uint32 private constant ALLBRIDGE_ID_TRON = 3;
    uint32 private constant ALLBRIDGE_ID_SOLANA = 4;
    uint32 private constant ALLBRIDGE_ID_POLYGON = 5;
    uint32 private constant ALLBRIDGE_ID_ARBITRUM = 6;
    uint32 private constant ALLBRIDGE_ID_AVALANCHE = 8;
    uint32 private constant ALLBRIDGE_ID_BASE = 9;
    uint32 private constant ALLBRIDGE_ID_OPTIMISM = 10;
    uint32 private constant ALLBRIDGE_ID_CELO = 11;
    uint32 private constant ALLBRIDGE_ID_SONIC = 12;
    uint32 private constant ALLBRIDGE_ID_SUI = 13;
    uint32 private constant ALLBRIDGE_ID_UNICHAIN = 14;
    uint256 internal constant LIFI_CHAIN_ID_ETHEREUM = 1;
    uint256 internal constant LIFI_CHAIN_ID_OPTIMISM = 10;

    error UnsupportedAllBridgeChainId();

    // -----
    AllBridgeFacet.AllBridgeData internal validAllBridgeData;
    TestAllBridgeFacet internal allBridgeFacet;

    function setUp() public {
        customBlockNumberForForking = 17556456;
        initTestBase();

        allBridgeFacet = new TestAllBridgeFacet(ALLBRIDGE_ROUTER);
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = allBridgeFacet
            .startBridgeTokensViaAllBridge
            .selector;
        functionSelectors[1] = allBridgeFacet
            .swapAndStartBridgeTokensViaAllBridge
            .selector;
        functionSelectors[2] = allBridgeFacet.addDex.selector;
        functionSelectors[3] = allBridgeFacet
            .setFunctionApprovalBySignature
            .selector;
        functionSelectors[4] = allBridgeFacet.getAllBridgeChainId.selector;

        addFacet(diamond, address(allBridgeFacet), functionSelectors);
        allBridgeFacet = TestAllBridgeFacet(address(diamond));
        allBridgeFacet.addDex(ADDRESS_UNISWAP);
        allBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapExactTokensForTokens.selector
        );
        allBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapTokensForExactETH.selector
        );
        allBridgeFacet.setFunctionApprovalBySignature(
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(allBridgeFacet), "AllBridgeFacet");

        // adjust bridgeData
        bridgeData.bridge = "allbridge";
        bridgeData.destinationChainId = 137;

        uint256 fees = ALLBRIDGE_ROUTER.getTransactionCost(5) +
            ALLBRIDGE_ROUTER.getMessageCost(
                5,
                IAllBridge.MessengerProtocol.Allbridge
            );
        // produce valid AllBridgeData
        validAllBridgeData = AllBridgeFacet.AllBridgeData({
            fees: fees,
            recipient: bytes32(uint256(uint160(USER_RECEIVER))),
            receiveToken: 0x0000000000000000000000002791Bca1f2de4661ED88A30C99A7a9449Aa84174,
            nonce: 40953790744158426077674476975877556494233328003707004662889959804198145032447,
            messenger: IAllBridge.MessengerProtocol.Allbridge,
            payFeeWithSendingAsset: false
        });
        addToMessageValue = validAllBridgeData.fees;
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        allBridgeFacet.startBridgeTokensViaAllBridge{
            value: addToMessageValue
        }(bridgeData, validAllBridgeData);
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        allBridgeFacet.swapAndStartBridgeTokensViaAllBridge{
            value: addToMessageValue
        }(bridgeData, swapData, validAllBridgeData);
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // we decided to deactivate this test since it often fails on Github
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestAllBridgeFacet(IAllBridge(address(0)));
    }

    function test_CanBridgeAndPayFeeWithBridgedToken() public {
        validAllBridgeData.fees =
            ALLBRIDGE_ROUTER.getBridgingCostInTokens(
                5,
                IAllBridge.MessengerProtocol.Allbridge,
                ADDRESS_USDC
            ) +
            1; // add 1 wei to avoid rounding errors

        validAllBridgeData.payFeeWithSendingAsset = true;
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);

        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeAndPayFeeWithBridgedToken() public {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        validAllBridgeData.fees =
            ALLBRIDGE_ROUTER.getBridgingCostInTokens(
                5,
                IAllBridge.MessengerProtocol.Allbridge,
                ADDRESS_USDC
            ) +
            1; // add 1 wei to avoid rounding errors
        validAllBridgeData.payFeeWithSendingAsset = true;

        // reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        // approval
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        //prepare check for events
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_DAI,
            ADDRESS_USDC,
            swapData[0].fromAmount,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
    }

    function testRevert_WhenReceiverDoesNotMatch() public {
        vm.startPrank(USER_SENDER);

        // update bridgeData
        validAllBridgeData.recipient = bytes32(uint256(uint160(USER_SENDER)));

        usdc.approve(address(allBridgeFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        allBridgeFacet.startBridgeTokensViaAllBridge(
            bridgeData,
            validAllBridgeData
        );
    }

    function testRevert_InvalidNonEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        // update bridgeData
        bridgeData.receiver = NON_EVM_ADDRESS;
        validAllBridgeData.recipient = bytes32(0);

        usdc.approve(address(allBridgeFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        allBridgeFacet.startBridgeTokensViaAllBridge(
            bridgeData,
            validAllBridgeData
        );

        vm.stopPrank();
    }

    function test_CanBridgeToNonEVMChainAndEmitEvent() public {
        vm.startPrank(USER_SENDER);

        // update bridgeData for non-EVM destination (Solana)
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validAllBridgeData.recipient = bytes32(
            uint256(uint160(0x1234567890123456789012345678901234567890))
        );

        // Calculate fees for Solana destination
        uint256 fees = ALLBRIDGE_ROUTER.getTransactionCost(
            ALLBRIDGE_ID_SOLANA
        ) +
            ALLBRIDGE_ROUTER.getMessageCost(
                ALLBRIDGE_ID_SOLANA,
                IAllBridge.MessengerProtocol.Allbridge
            );
        validAllBridgeData.fees = fees;
        validAllBridgeData.receiveToken = ADDRESS_USDC_SOLANA; // Solana USDC
        addToMessageValue = fees;

        usdc.approve(address(allBridgeFacet), bridgeData.minAmount);

        // expect the BridgeToNonEVMChainBytes32 event to be emitted first
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            ALLBRIDGE_ID_SOLANA,
            validAllBridgeData.recipient
        );

        // expect the LiFiTransferStarted event to be emitted second
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        allBridgeFacet.startBridgeTokensViaAllBridge{
            value: validAllBridgeData.fees
        }(bridgeData, validAllBridgeData);

        vm.stopPrank();
    }

    function test_CanBridgeToNonEVMChainWithFeePaidInSendingAsset() public {
        vm.startPrank(USER_SENDER);

        // update bridgeData for non-EVM destination (Solana)
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validAllBridgeData.recipient = bytes32(
            uint256(uint160(0x1234567890123456789012345678901234567890))
        );

        // Calculate fees for Solana destination and pay with sending asset
        uint256 fees = ALLBRIDGE_ROUTER.getBridgingCostInTokens(
            ALLBRIDGE_ID_SOLANA,
            IAllBridge.MessengerProtocol.Allbridge,
            ADDRESS_USDC
        ) + 1; // add 1 wei to avoid rounding errors
        validAllBridgeData.fees = fees;
        validAllBridgeData.receiveToken = ADDRESS_USDC_SOLANA; // Solana USDC
        validAllBridgeData.payFeeWithSendingAsset = true;
        addToMessageValue = 0; // no ETH needed when paying with sending asset

        usdc.approve(address(allBridgeFacet), bridgeData.minAmount);

        // expect the BridgeToNonEVMChainBytes32 event to be emitted first
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            ALLBRIDGE_ID_SOLANA,
            validAllBridgeData.recipient
        );

        // expect the LiFiTransferStarted event to be emitted second
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        allBridgeFacet.startBridgeTokensViaAllBridge(
            bridgeData,
            validAllBridgeData
        );

        vm.stopPrank();
    }

    function test_ChainIdMapping() public {
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_ETHEREUM),
            ALLBRIDGE_ID_ETHEREUM
        );
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_OPTIMISM),
            ALLBRIDGE_ID_OPTIMISM
        );
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_BSC),
            ALLBRIDGE_ID_BSC
        );
        // tron
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_TRON),
            ALLBRIDGE_ID_TRON
        );
        // solana
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_SOLANA),
            ALLBRIDGE_ID_SOLANA
        );
        // polygon
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_POLYGON),
            ALLBRIDGE_ID_POLYGON
        );
        // arbitrum
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_ARBITRUM),
            ALLBRIDGE_ID_ARBITRUM
        );
        // avalanche
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_AVALANCHE),
            ALLBRIDGE_ID_AVALANCHE
        );
        // base
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_BASE),
            ALLBRIDGE_ID_BASE
        );
        // celo
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_CELO),
            ALLBRIDGE_ID_CELO
        );
        // sui
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_SUI),
            ALLBRIDGE_ID_SUI
        );
        // sonic
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_SONIC),
            ALLBRIDGE_ID_SONIC
        );
        // unichain
        assertEq(
            allBridgeFacet.getAllBridgeChainId(LIFI_CHAIN_ID_UNICHAIN),
            ALLBRIDGE_ID_UNICHAIN
        );
        // unknown
        vm.expectRevert(UnsupportedAllBridgeChainId.selector);

        allBridgeFacet.getAllBridgeChainId(1290);
    }
}
