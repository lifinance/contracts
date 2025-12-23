// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet, LibSwap } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { NEARIntentsFacet } from "lifi/Facets/NEARIntentsFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { InvalidReceiver, InvalidAmount, InformationMismatch, InvalidConfig, InvalidNonEVMReceiver } from "lifi/Errors/GenericErrors.sol";

error QuoteAlreadyConsumed();
error QuoteExpired();
error InvalidSignature();

/// @title TestNEARIntentsFacet
/// @author LI.FI (https://li.fi)
/// @notice Test contract wrapper for NEARIntentsFacet
/// @custom:version 1.0.0
contract TestNEARIntentsFacet is NEARIntentsFacet, TestWhitelistManagerBase {
    constructor(address _backendSigner) NEARIntentsFacet(_backendSigner) {}

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

    // Event definition for testing (matches NEARIntentsFacet.NEARIntentsBridgeStarted)
    event NEARIntentsBridgeStarted(
        bytes32 indexed transactionId,
        bytes32 indexed quoteId,
        address indexed depositAddress,
        address sendingAssetId,
        uint256 amount,
        uint256 deadline,
        uint256 minAmountOut
    );

    // Test constants
    bytes32 internal constant TEST_QUOTE_ID = keccak256("test-quote-1");
    address internal constant TEST_DEPOSIT_ADDRESS =
        0x0000000000000000000000000000000000000DeA;
    uint256 internal constant DEFAULT_DEADLINE = 1 hours;

    // Backend signer private key and address
    uint256 internal backendSignerPrivateKey =
        0x1234567890123456789012345678901234567890123456789012345678901234;
    address internal backendSignerAddress = vm.addr(backendSignerPrivateKey);

    // EIP-712 typehash for NEARIntentsPayload
    bytes32 internal constant NEARINTENTS_PAYLOAD_TYPEHASH =
        0x26e3f312476209e792e713eef13bd95c5da5292aba26e299c7d8e7c647d7903e;

    struct NEARIntentsPayload {
        bytes32 transactionId;
        uint256 minAmount;
        bytes32 receiver;
        address depositAddress;
        uint256 destinationChainId;
        address sendingAssetId;
        uint256 deadline;
        bytes32 quoteId;
        uint256 minAmountOut;
    }

    NEARIntentsFacet.NEARIntentsData internal validNearData;

    function setUp() public {
        customBlockNumberForForking = 19767662;
        initTestBase();

        // Deploy facet with backend signer
        nearIntentsFacet = new TestNEARIntentsFacet(backendSignerAddress);

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
        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            990 * 10 ** 6
        );
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

    /// Base Test Overrides (regenerate signatures when bridgeData changes) ///

    function testBase_CanBridgeNativeTokens() public override {
        // Customize bridgeData first
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        // Regenerate signature with updated bridgeData
        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            defaultNativeAmount - (defaultNativeAmount / 100) // 1% slippage
        );

        vm.startPrank(USER_SENDER);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(true);
        vm.stopPrank();
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 100 && amount < 10000000);
        bridgeData.minAmount = amount;

        // Regenerate signature with fuzzed amount
        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            amount - (amount / 100) // 1% slippage
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), amount);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        vm.startPrank(USER_SENDER);

        // prepare bridgeData
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        // prepare swap data - swap USDC to Native
        address[] memory path = new address[](2);
        path[0] = ADDRESS_USDC;
        path[1] = ADDRESS_WRAPPED_NATIVE;

        uint256 amountOut = defaultNativeAmount;

        // Calculate USDC input amount
        uint256[] memory amounts = uniswap.getAmountsIn(amountOut, path);
        uint256 amountIn = amounts[0];

        bridgeData.minAmount = amountOut;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    amountOut,
                    amountIn,
                    path,
                    address(diamond),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        // Regenerate signature with swap output amount
        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            bridgeData.minAmount - (bridgeData.minAmount / 100) // 1% slippage
        );

        // approval
        usdc.approve(address(diamond), amountIn);

        //prepare check for events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit AssetSwapped(
            bridgeData.transactionId,
            ADDRESS_UNISWAP,
            ADDRESS_USDC,
            address(0),
            amountIn,
            bridgeData.minAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        // execute call in child contract
        initiateSwapAndBridgeTxWithFacet(false);
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
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
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
        // Customize bridgeData for native tokens
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        // Regenerate signature with updated bridgeData
        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            keccak256("test-quote-native"),
            defaultNativeAmount - (defaultNativeAmount / 100) // 1% slippage
        );

        vm.startPrank(USER_SENDER);

        // Record balances
        uint256 userBalanceBefore = USER_SENDER.balance;
        uint256 depositBalanceBefore = TEST_DEPOSIT_ADDRESS.balance;

        // Expect events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        // Execute
        nearIntentsFacet.startBridgeTokensViaNEARIntents{
            value: bridgeData.minAmount
        }(bridgeData, validNearData);
        vm.stopPrank();

        // Assert balances
        assertEq(
            USER_SENDER.balance,
            userBalanceBefore - bridgeData.minAmount
        );
        assertEq(
            TEST_DEPOSIT_ADDRESS.balance,
            depositBalanceBefore + bridgeData.minAmount
        );
        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    /// Validation Revert Tests ///

    function testRevert_QuoteAlreadyConsumed() public {
        // Mark quote as consumed
        nearIntentsFacet.setQuoteConsumed(validNearData.quoteId);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(QuoteAlreadyConsumed.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_QuoteExpired() public {
        // Setup expired quote - deadline in the past
        uint256 expiredDeadline = block.timestamp - 1;

        NEARIntentsPayload memory payload = _createNEARIntentsPayload(
            bridgeData,
            TEST_DEPOSIT_ADDRESS,
            expiredDeadline,
            TEST_QUOTE_ID,
            990 * 10 ** 6
        );

        bytes32 domainSeparator = _buildDomainSeparator(block.chainid);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory signature = _signDigest(backendSignerPrivateKey, digest);

        validNearData = NEARIntentsFacet.NEARIntentsData({
            nonEVMReceiver: bytes32(0),
            depositAddress: TEST_DEPOSIT_ADDRESS,
            quoteId: TEST_QUOTE_ID,
            deadline: expiredDeadline,
            minAmountOut: 990 * 10 ** 6,
            refundRecipient: USER_SENDER,
            signature: signature
        });

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        // The modifier onlyValidQuote checks deadline first, throwing QuoteExpired
        vm.expectRevert(QuoteExpired.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_InvalidDepositAddress() public {
        validNearData = _generateValidNearData(
            address(0),
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            990 * 10 ** 6
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);
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

        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            0.99 ether
        );

        uint256 excessAmount = 0.5 ether;

        vm.startPrank(USER_SENDER);

        uint256 balanceBefore = USER_SENDER.balance;

        // Expect events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        nearIntentsFacet.startBridgeTokensViaNEARIntents{
            value: 1 ether + excessAmount
        }(bridgeData, validNearData);

        // Should have refunded excess
        assertEq(USER_SENDER.balance, balanceBefore - 1 ether);
        vm.stopPrank();
    }

    function test_HandlesMinimalAmounts() public {
        bridgeData.minAmount = 1; // 1 wei equivalent

        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            1
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), 1);

        // Expect events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

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

        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            maxAmount - 1
        );

        // Deal tokens for max amount
        deal(ADDRESS_USDC, USER_SENDER, maxAmount);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), maxAmount);

        // Expect events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

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

        // Expect events for first bridge
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        // First bridge
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );

        // Second bridge with different quoteId
        bytes32 newQuoteId = keccak256("test-quote-2");
        NEARIntentsFacet.NEARIntentsData
            memory newNearData = _generateValidNearData(
                TEST_DEPOSIT_ADDRESS,
                bridgeData,
                block.chainid,
                newQuoteId,
                990 * 10 ** 6
            );

        // Expect events for second bridge
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            newNearData.quoteId,
            newNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            newNearData.deadline,
            newNearData.minAmountOut
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            newNearData
        );
        vm.stopPrank();

        assertTrue(nearIntentsFacet.isQuoteConsumed(TEST_QUOTE_ID));
        assertTrue(nearIntentsFacet.isQuoteConsumed(newQuoteId));
    }

    function test_CanDeployFacet() public {
        new NEARIntentsFacet(backendSignerAddress);
    }

    function testRevert_ConstructorWithZeroBackendSigner() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestNEARIntentsFacet(address(0));
    }

    function testRevert_InvalidSignature() public {
        // Generate invalid signature with wrong private key
        uint256 wrongPrivateKey = 0x9999999999999999999999999999999999999999999999999999999999999999;

        validNearData = _generateValidNearDataWithPrivateKey(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            990 * 10 ** 6,
            wrongPrivateKey
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(InvalidSignature.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function testRevert_SignatureExpired() public {
        // Generate signature with expired deadline
        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            990 * 10 ** 6
        );

        // Move time forward past deadline
        vm.warp(validNearData.deadline + 1);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        // The modifier onlyValidQuote checks deadline with > comparison, throwing QuoteExpired
        vm.expectRevert(QuoteExpired.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    /// Non-EVM Address Tests ///

    function test_CanBridgeToNonEVMChain() public {
        // Setup bridge to non-EVM chain (NEAR)
        bridgeData.receiver = NON_EVM_ADDRESS;
        bytes32 nonEVMReceiver = keccak256("alice.near");

        validNearData = _generateValidNearDataWithNonEVM(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            990 * 10 ** 6,
            nonEVMReceiver
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        uint256 depositBalanceBefore = usdc.balanceOf(TEST_DEPOSIT_ADDRESS);

        // Expect NEARIntentsBridgeStarted event
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        // Expect special non-EVM event
        vm.expectEmit(true, true, true, true, address(diamond));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();

        // Assert balances
        assertEq(
            usdc.balanceOf(TEST_DEPOSIT_ADDRESS),
            depositBalanceBefore + bridgeData.minAmount
        );
        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    function test_CanSwapAndBridgeToNonEVMChain() public {
        // Setup bridge to non-EVM chain
        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.hasSourceSwaps = true;
        bytes32 nonEVMReceiver = keccak256("bob.near");

        setDefaultSwapDataSingleDAItoUSDC();

        validNearData = _generateValidNearDataWithNonEVM(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            990 * 10 ** 6,
            nonEVMReceiver
        );

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        uint256 depositBalanceBefore = usdc.balanceOf(TEST_DEPOSIT_ADDRESS);

        // Expect NEARIntentsBridgeStarted event
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        // Expect special non-EVM event
        vm.expectEmit(true, true, true, true, address(diamond));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            nonEVMReceiver
        );

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

    function testRevert_InvalidNonEVMReceiver() public {
        // Setup bridge to non-EVM chain but with empty nonEVMReceiver
        bridgeData.receiver = NON_EVM_ADDRESS;

        validNearData = _generateValidNearData(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            990 * 10 ** 6
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);
        nearIntentsFacet.startBridgeTokensViaNEARIntents(
            bridgeData,
            validNearData
        );
        vm.stopPrank();
    }

    function test_PositiveSlippageRefundedToRefundRecipient() public {
        // Setup swap from DAI to USDC with potential positive slippage
        bridgeData.hasSourceSwaps = true;

        // Use a specific refund recipient (different from sender for clarity)
        address refundRecipient = address(0xBEEF);

        // Reset swap data
        setDefaultSwapDataSingleDAItoUSDC();

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        // Generate nearData with custom refund recipient
        NEARIntentsFacet.NEARIntentsData
            memory customNearData = _generateValidNearData(
                TEST_DEPOSIT_ADDRESS,
                bridgeData,
                block.chainid,
                TEST_QUOTE_ID,
                990 * 10 ** 6
            );
        customNearData.refundRecipient = refundRecipient;

        uint256 depositBalanceBefore = usdc.balanceOf(TEST_DEPOSIT_ADDRESS);
        uint256 refundRecipientBalanceBefore = usdc.balanceOf(refundRecipient);

        // Expect events
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            customNearData.quoteId,
            customNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            customNearData.deadline,
            customNearData.minAmountOut
        );

        nearIntentsFacet.swapAndStartBridgeTokensViaNEARIntents(
            bridgeData,
            swapData,
            customNearData
        );
        vm.stopPrank();

        // Deposit address should receive exactly minAmount
        assertEq(
            usdc.balanceOf(TEST_DEPOSIT_ADDRESS),
            depositBalanceBefore + bridgeData.minAmount
        );

        // If there was positive slippage, refund recipient should receive it
        uint256 refundRecipientBalanceAfter = usdc.balanceOf(refundRecipient);
        if (refundRecipientBalanceAfter > refundRecipientBalanceBefore) {
            // Positive slippage was refunded
            assertTrue(
                refundRecipientBalanceAfter > refundRecipientBalanceBefore
            );
        }
    }

    function test_NonEVMBridgeWithNativeTokens() public {
        // Setup
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;
        bridgeData.receiver = NON_EVM_ADDRESS;
        bytes32 nonEVMReceiver = keccak256("charlie.near");

        validNearData = _generateValidNearDataWithNonEVM(
            TEST_DEPOSIT_ADDRESS,
            bridgeData,
            block.chainid,
            TEST_QUOTE_ID,
            0.99 ether,
            nonEVMReceiver
        );

        vm.startPrank(USER_SENDER);

        uint256 depositBalanceBefore = TEST_DEPOSIT_ADDRESS.balance;

        // Expect NEARIntentsBridgeStarted event
        vm.expectEmit(true, true, true, true, address(diamond));
        emit NEARIntentsBridgeStarted(
            bridgeData.transactionId,
            validNearData.quoteId,
            validNearData.depositAddress,
            bridgeData.sendingAssetId,
            bridgeData.minAmount,
            validNearData.deadline,
            validNearData.minAmountOut
        );

        // Expect special non-EVM event
        vm.expectEmit(true, true, true, true, address(diamond));
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            bridgeData.destinationChainId,
            nonEVMReceiver
        );

        vm.expectEmit(true, true, true, true, address(diamond));
        emit LiFiTransferStarted(bridgeData);

        nearIntentsFacet.startBridgeTokensViaNEARIntents{ value: 1 ether }(
            bridgeData,
            validNearData
        );
        vm.stopPrank();

        assertEq(TEST_DEPOSIT_ADDRESS.balance, depositBalanceBefore + 1 ether);
        assertTrue(nearIntentsFacet.isQuoteConsumed(validNearData.quoteId));
    }

    /// Helper Functions ///

    /// @dev Builds the EIP-712 domain separator for the given chain
    /// @param _chainId The chain ID
    /// @return The domain separator hash
    function _buildDomainSeparator(
        uint256 _chainId
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes("LI.FI NEAR Intents Facet")),
                    keccak256(bytes("1")),
                    _chainId,
                    address(nearIntentsFacet)
                )
            );
    }

    /// @dev Creates a NEARIntentsPayload struct from bridge data and additional parameters
    /// @param _bridgeData The bridge data containing transaction details
    /// @param _depositAddress The deposit address for the transaction
    /// @param _deadline The deadline for the transaction
    /// @param _quoteId The quote ID
    /// @param _minAmountOut The minimum amount out
    /// @return The constructed NEARIntentsPayload struct
    function _createNEARIntentsPayload(
        ILiFi.BridgeData memory _bridgeData,
        address _depositAddress,
        uint256 _deadline,
        bytes32 _quoteId,
        uint256 _minAmountOut
    ) internal pure returns (NEARIntentsPayload memory) {
        return
            NEARIntentsPayload({
                transactionId: _bridgeData.transactionId,
                minAmount: _bridgeData.minAmount,
                receiver: bytes32(uint256(uint160(_bridgeData.receiver))),
                depositAddress: _depositAddress,
                destinationChainId: _bridgeData.destinationChainId,
                sendingAssetId: _bridgeData.sendingAssetId,
                deadline: _deadline,
                quoteId: _quoteId,
                minAmountOut: _minAmountOut
            });
    }

    /// @dev Builds the struct hash for the NEARIntentsPayload
    /// @param _payload The NEARIntentsPayload to hash
    /// @return The computed struct hash
    function _buildStructHash(
        NEARIntentsPayload memory _payload
    ) internal pure returns (bytes32) {
        // Convert address receiver to bytes32 for compatibility
        bytes32 receiverHash = _payload.receiver;

        return
            keccak256(
                abi.encode(
                    NEARINTENTS_PAYLOAD_TYPEHASH,
                    _payload.transactionId,
                    _payload.minAmount,
                    receiverHash,
                    _payload.depositAddress,
                    _payload.destinationChainId,
                    _payload.sendingAssetId,
                    _payload.deadline,
                    _payload.quoteId,
                    _payload.minAmountOut
                )
            );
    }

    /// @dev Builds the final EIP-712 digest from domain separator and struct hash
    /// @param _domainSeparator The domain separator hash
    /// @param _structHash The struct hash
    /// @return The computed digest ready for signing
    function _buildDigest(
        bytes32 _domainSeparator,
        bytes32 _structHash
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked("\x19\x01", _domainSeparator, _structHash)
            );
    }

    /// @dev Signs a digest with the given private key
    /// @param _privateKey The private key to sign with
    /// @param _digest The digest to sign
    /// @return The signature bytes (r, s, v format)
    function _signDigest(
        uint256 _privateKey,
        bytes32 _digest
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_privateKey, _digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Helper function to generate valid NEAR Intents data with custom private key
    function _generateValidNearDataWithPrivateKey(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId,
        bytes32 _quoteId,
        uint256 _minAmountOut,
        uint256 _privateKey
    ) internal view returns (NEARIntentsFacet.NEARIntentsData memory) {
        uint256 deadline = block.timestamp + DEFAULT_DEADLINE;

        NEARIntentsPayload memory payload = _createNEARIntentsPayload(
            _currentBridgeData,
            _depositAddress,
            deadline,
            _quoteId,
            _minAmountOut
        );

        bytes32 domainSeparator = _buildDomainSeparator(_chainId);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory signature = _signDigest(_privateKey, digest);

        return
            NEARIntentsFacet.NEARIntentsData({
                nonEVMReceiver: bytes32(0),
                depositAddress: _depositAddress,
                quoteId: _quoteId,
                deadline: deadline,
                minAmountOut: _minAmountOut,
                refundRecipient: USER_SENDER,
                signature: signature
            });
    }

    /// @dev Helper function to generate valid NEAR Intents data
    function _generateValidNearData(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId,
        bytes32 _quoteId,
        uint256 _minAmountOut
    ) internal view returns (NEARIntentsFacet.NEARIntentsData memory) {
        return
            _generateValidNearDataWithPrivateKey(
                _depositAddress,
                _currentBridgeData,
                _chainId,
                _quoteId,
                _minAmountOut,
                backendSignerPrivateKey
            );
    }

    /// @dev Helper function to generate valid NEAR Intents data with non-EVM receiver
    function _generateValidNearDataWithNonEVM(
        address _depositAddress,
        ILiFi.BridgeData memory _currentBridgeData,
        uint256 _chainId,
        bytes32 _quoteId,
        uint256 _minAmountOut,
        bytes32 _nonEVMReceiver
    ) internal view returns (NEARIntentsFacet.NEARIntentsData memory) {
        uint256 deadline = block.timestamp + DEFAULT_DEADLINE;

        // Create payload with nonEVMReceiver
        NEARIntentsPayload memory payload = NEARIntentsPayload({
            transactionId: _currentBridgeData.transactionId,
            minAmount: _currentBridgeData.minAmount,
            receiver: _nonEVMReceiver,
            depositAddress: _depositAddress,
            destinationChainId: _currentBridgeData.destinationChainId,
            sendingAssetId: _currentBridgeData.sendingAssetId,
            deadline: deadline,
            quoteId: _quoteId,
            minAmountOut: _minAmountOut
        });

        bytes32 domainSeparator = _buildDomainSeparator(_chainId);
        bytes32 structHash = _buildStructHash(payload);
        bytes32 digest = _buildDigest(domainSeparator, structHash);
        bytes memory signature = _signDigest(backendSignerPrivateKey, digest);

        return
            NEARIntentsFacet.NEARIntentsData({
                nonEVMReceiver: _nonEVMReceiver,
                depositAddress: _depositAddress,
                quoteId: _quoteId,
                deadline: deadline,
                minAmountOut: _minAmountOut,
                refundRecipient: USER_SENDER,
                signature: signature
            });
    }
}
