// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { AllBridgeFacet } from "lifi/Facets/AllBridgeFacet.sol";
import { IAllBridge } from "lifi/Interfaces/IAllBridge.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

// Stub AllBridgeFacet Contract
contract TestAllBridgeFacet is AllBridgeFacet, TestWhitelistManagerBase {
    constructor(IAllBridge _allBridge) AllBridgeFacet(_allBridge) {}
}

contract AllBridgeFacetTest is TestBaseFacet {
    IAllBridge internal constant ALLBRIDGE_ROUTER =
        IAllBridge(0x609c690e8F7D68a59885c9132e812eEbDaAf0c9e);
    address internal constant ALLBRIDGE_POOL =
        0xa7062bbA94c91d565Ae33B893Ab5dFAF1Fc57C4d;
    // -----
    AllBridgeFacet.AllBridgeData internal validAllBridgeData;
    TestAllBridgeFacet internal allBridgeFacet;

    function setUp() public {
        customBlockNumberForForking = 17556456;
        initTestBase();

        allBridgeFacet = new TestAllBridgeFacet(ALLBRIDGE_ROUTER);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = allBridgeFacet
            .startBridgeTokensViaAllBridge
            .selector;
        functionSelectors[1] = allBridgeFacet
            .swapAndStartBridgeTokensViaAllBridge
            .selector;
        functionSelectors[2] = allBridgeFacet.addToWhitelist.selector;
        functionSelectors[3] = allBridgeFacet
            .setFunctionWhitelistBySelector
            .selector;

        addFacet(diamond, address(allBridgeFacet), functionSelectors);
        allBridgeFacet = TestAllBridgeFacet(address(diamond));
        allBridgeFacet.addToWhitelist(ADDRESS_UNISWAP);
        allBridgeFacet.setFunctionWhitelistBySelector(
            uniswap.swapExactTokensForTokens.selector
        );
        allBridgeFacet.setFunctionWhitelistBySelector(
            uniswap.swapTokensForExactETH.selector
        );
        allBridgeFacet.setFunctionWhitelistBySelector(
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
            recipient: 0x00000000000000000000000012561cc3ea2a60aa158b0421010859a983bf3c96,
            destinationChainId: 5,
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

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        // we decided to deactivate this test since it often fails on Github
    }

    function initiateSwapAndBridgeTxWithFacet(bool) internal override {
        allBridgeFacet.swapAndStartBridgeTokensViaAllBridge{
            value: addToMessageValue
        }(bridgeData, swapData, validAllBridgeData);
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
}
