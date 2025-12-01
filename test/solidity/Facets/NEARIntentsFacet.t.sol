// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { NEARIntentsFacet } from "lifi/Facets/NEARIntentsFacet.sol";
import { InvalidReceiver, InvalidAmount, CannotBridgeToSameNetwork, InformationMismatch } from "lifi/Errors/GenericErrors.sol";

/// @title TestNEARIntentsFacet
/// @author LI.FI (https://li.fi)
/// @notice Test contract wrapper for NEARIntentsFacet
/// @custom:version 1.0.0
contract TestNEARIntentsFacet is NEARIntentsFacet, TestWhitelistManagerBase {
    function setQuoteConsumed(bytes32 _quoteId) external {
        Storage storage s = _getStorage();
        s.consumedQuoteIds[_quoteId] = true;
    }

    function _getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = keccak256("com.lifi.facets.nearintents");
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}

/// @title NEARIntentsFacetTest
/// @author LI.FI (https://li.fi)
/// @notice Test suite for NEARIntentsFacet
/// @custom:version 1.0.0
contract NEARIntentsFacetTest is TestBaseFacet {
    TestNEARIntentsFacet internal nearIntentsFacet;

    // Test constants
    bytes32 internal constant TEST_QUOTE_ID = keccak256("test-quote-1");
    address internal constant TEST_DEPOSIT_ADDRESS =
        0x0000000000000000000000000000000000000DeA;
    uint256 internal constant DEFAULT_DEADLINE = 1 hours;

    NEARIntentsFacet.NEARIntentsData internal validNearData;

    function setUp() public {
        customBlockNumberForForking = 19767662;
        initTestBase();

        // Deploy facet
        nearIntentsFacet = new TestNEARIntentsFacet();

        // Register selectors with diamond
        bytes4[] memory functionSelectors = new bytes4[](5);
        functionSelectors[0] = nearIntentsFacet
            .startBridgeTokensViaNEARIntents
            .selector;
        functionSelectors[1] = nearIntentsFacet
            .swapAndStartBridgeTokensViaNEARIntents
            .selector;
        functionSelectors[2] = nearIntentsFacet.isQuoteConsumed.selector;
        functionSelectors[3] = nearIntentsFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[4] = nearIntentsFacet.setQuoteConsumed.selector;

        addFacet(diamond, address(nearIntentsFacet), functionSelectors);
        nearIntentsFacet = TestNEARIntentsFacet(address(diamond));

        // Setup whitelist for swaps
        nearIntentsFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        nearIntentsFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        nearIntentsFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForETH.selector
        );
        nearIntentsFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactETHForTokens.selector
        );

        // Set facet address in test base
        setFacetAddressInTestBase(
            address(nearIntentsFacet),
            "NEARIntentsFacet"
        );

        // adjust bridgeData
        bridgeData.bridge = "near-intents";
        bridgeData.destinationChainId = 1313161554; // NEAR Aurora as placeholder

        // Setup valid test data
        _setupValidNearData();
    }

    function _setupValidNearData() internal {
        validNearData = NEARIntentsFacet.NEARIntentsData({
            quoteId: TEST_QUOTE_ID,
            depositAddress: TEST_DEPOSIT_ADDRESS,
            deadline: block.timestamp + DEFAULT_DEADLINE,
            minAmountOut: 990 * 10 ** 6 // 990 USDC (1% slippage)
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            nearIntentsFacet.startBridgeTokensViaNEARIntents{
                value: bridgeData.minAmount
            }(bridgeData, validNearData);
        } else {
            nearIntentsFacet.startBridgeTokensViaNEARIntents(
                bridgeData,
                validNearData
            );
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            nearIntentsFacet.swapAndStartBridgeTokensViaNEARIntents{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validNearData);
        } else {
            nearIntentsFacet.swapAndStartBridgeTokensViaNEARIntents(
                bridgeData,
                swapData,
                validNearData
            );
        }
    }

    /// Happy Path Tests ///

    function test_CanBridgeERC20Tokens() public {
        vm.startPrank(USER_SENDER);

        // approval
        usdc.approve(address(diamond), bridgeData.minAmount);

        // Record balances
        uint256 userBalanceBefore = usdc.balanceOf(USER_SENDER);
        uint256 depositBalanceBefore = usdc.balanceOf(TEST_DEPOSIT_ADDRESS);

        // Expect events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsFacet.NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        // Execute
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();

        // Assert balances
        assertEq(
            usdc.balanceOf(USER_SENDER),
            userBalanceBefore - bridgeData.minAmount
        );
        assertEq(
            usdc.balanceOf(TEST_DEPOSIT_ADDRESS),
            depositBalanceBefore + bridgeData.minAmount
        );
        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    function test_CanBridgeNativeTokens() public {
        // Setup
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        validNearData.minAmountOut = 0.99 ether;

        vm.startPrank(USER_SENDER);

        // Record balances
        uint256 depositBalanceBefore = TEST_DEPOSIT_ADDRESS.balance;

        // Expect events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsFacet.NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        // Execute
        nearIntentsFacet.startBridgeTokensViaNEARIntents{ value: 1 ether }(
            bridgeData,
            validNearData
        );
        vm.stopPrank();

        // Assert
        assertEq(TEST_DEPOSIT_ADDRESS.balance, depositBalanceBefore + 1 ether);
        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    function test_CanSwapAndBridgeTokens() public {
        // Setup swap from DAI to USDC
        bridgeData.hasSourceSwaps = true;

        // Reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        uint256 depositBalanceBefore = usdc.balanceOf(TEST_DEPOSIT_ADDRESS);

        nearIntentsFacet.swapAndStartBridgeTokensViaNEARIntents(
            bridgeData,
            swapData,
            validNearData
        );
        vm.stopPrank();

        assertTrue(
            usdc.balanceOf(TEST_DEPOSIT_ADDRESS) > depositBalanceBefore
        );
        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    /// Validation Revert Tests ///

    function testRevert_QuoteAlreadyConsumed() public {
        // Mark quote as consumed
        nearIntentsFacet.setQuoteConsumed(validNearData.quoteId);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(NEARIntentsFacet.QuoteAlreadyConsumed.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_QuoteExpired() public {
        // Setup expired quote
        validNearData.deadline = block.timestamp - 1;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(NEARIntentsFacet.QuoteExpired.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_InvalidDepositAddress() public {
        validNearData.depositAddress = address(0);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(NEARIntentsFacet.InvalidDepositAddress.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_InvalidReceiverAddress() public {
        bridgeData.receiver = address(0);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_InvalidAmount() public {
        bridgeData.minAmount = 0;

        vm.startPrank(USER_SENDER);

        vm.expectRevert(InvalidAmount.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_SameChainId() public {
        bridgeData.destinationChainId = block.chainid;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(CannotBridgeToSameNetwork.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_SourceSwapsFlagMismatch() public {
        // Bridge data says no swaps but function expects swaps
        bridgeData.hasSourceSwaps = false;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        LibSwap.SwapData[] memory swapDataEmpty = new LibSwap.SwapData[](0);

        vm.expectRevert(InformationMismatch.selector);
        nearIntentsFacet.swapAndStartBridgeTokensViaNEARIntents(
            bridgeData,
            swapDataEmpty,
            validNearData
        );
        vm.stopPrank();
    }

    /// Edge Case Tests ///

    function test_RefundsExcessNativeToken() public {
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        validNearData.minAmountOut = 0.99 ether;

        uint256 excessAmount = 0.5 ether;

        vm.startPrank(USER_SENDER);

        uint256 balanceBefore = USER_SENDER.balance;

        nearIntentsFacet.startBridgeTokensViaNEARIntents{
            value: 1 ether + excessAmount
        }(bridgeData, validNearData);

        // Should have refunded excess
        assertEq(USER_SENDER.balance, balanceBefore - 1 ether);
        vm.stopPrank();
    }

    function test_HandlesMinimalAmounts() public {
        bridgeData.minAmount = 1; // 1 wei equivalent

        validNearData.minAmountOut = 1;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), 1);

        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();

        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    function test_HandlesMaxAmounts() public {
        uint256 maxAmount = type(uint128).max;
        bridgeData.minAmount = maxAmount;

        validNearData.minAmountOut = maxAmount - 1;

        // Deal tokens for max amount
        deal(ADDRESS_USDC, USER_SENDER, maxAmount);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), maxAmount);

        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();

        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    function test_DifferentQuoteIdsCanBeUsed() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount * 2);

        // First bridge
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );

        // Second bridge with different quoteId
        bytes32 newQuoteId = keccak256("test-quote-2");
        validNearData.quoteId = newQuoteId;

        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();

        assertTrue(nearIntentsFacet.isQuoteConsumed(TEST_QUOTE_ID));
        assertTrue(nearIntentsFacet.isQuoteConsumed(newQuoteId));
    }

    function test_CanDeployFacet() public {
        new NEARIntentsFacet();
    }
}
