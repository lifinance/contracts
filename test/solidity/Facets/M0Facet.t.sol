// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Vm } from "forge-std/Vm.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { M0Facet } from "lifi/Facets/M0Facet.sol";
import { IM0OrderBook } from "lifi/Interfaces/IM0OrderBook.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
// solhint-disable-next-line max-line-length
import { CumulativeSlippageTooHigh, InformationMismatch, InvalidAmount, InvalidCallData, InvalidConfig, InvalidNonEVMReceiver, InvalidReceiver, NativeAssetNotSupported } from "lifi/Errors/GenericErrors.sol";
import { SafeCastLib } from "solady/utils/SafeCastLib.sol";

/// @dev Read-only slice of the live OrderBook used to assert post-conditions and to
///      name the protocol-level reverts the facet deliberately delegates. Kept local so
///      the production interface stays limited to what the facet actually calls.
interface IM0OrderBookState {
    struct Order {
        uint8 status;
        uint16 version;
        address sender;
        uint64 nonce;
        uint32 destChainId;
        uint32 createdAt;
        uint32 fillDeadline;
        address tokenIn;
        bytes32 tokenOut;
        uint128 amountIn;
        uint128 amountOut;
        bytes32 recipient;
        bytes32 solver;
    }

    error AmountOutZero();
    error InvalidDeadline();
    error InvalidDestinationChain();
    error SameTokenOrder();

    function getOrder(bytes32 orderId) external view returns (Order memory);

    function paused() external view returns (bool);
}

contract TestM0Facet is M0Facet, TestWhitelistManagerBase {
    constructor(IM0OrderBook _orderBook) M0Facet(_orderBook) {}
}

contract M0FacetTest is TestBaseFacet {
    /// @dev keccak256 of the OrderBook's OrderOpened signature. Non-indexed:
    ///      orderId, funder, tokenIn, amountIn, tokenOut, amountOut, fillDeadline.
    ///      Indexed: sender, destChainId, solver.
    bytes32 internal constant ORDER_OPENED_TOPIC =
        keccak256(
            // solhint-disable-next-line max-line-length
            "OrderOpened(bytes32,address,address,address,uint128,uint32,bytes32,uint128,bytes32,uint32)"
        );

    /// @dev `OrderStatus.Opened` as stored by the live OrderBook.
    uint8 internal constant ORDER_STATUS_OPENED = 1;

    /// @dev The M0 OrderBook proxy. Deployed deterministically, same address on every chain.
    IM0OrderBook internal constant ORDER_BOOK =
        IM0OrderBook(0xe39B012AB3b20E94a9beEa557eB0DE4171D4D3E4);

    uint256 internal constant DEST_CHAIN_ID = 8453; // Base
    /// @dev M0's own id for Solana; the facet translates LIFI_CHAIN_ID_SOLANA into it.
    uint32 internal constant M0_CHAIN_ID_SOLANA = 1399811149;

    /// @dev The $M token. The OrderBook never validates tokenOut, so any non-zero value
    ///      opens a fillable order; this is the token real M0 orders actually request.
    bytes32 internal constant TOKEN_OUT =
        bytes32(uint256(uint160(0x23238f20b894f29041f48D88eE91131C395Aaa71)));
    /// @dev A 32-byte Solana account, used as the non-EVM receiver.
    bytes32 internal constant SOLANA_RECEIVER =
        0xc6fa7af3bedbad3a3d65f36aabc97431b1bbe4c2d2f6e0e47ca60203452f5d61;
    /// @dev A 32-byte SPL mint. Uses the full width, so it is only valid for a non-EVM
    ///      destination — on an EVM one the facet rejects it as not an address.
    bytes32 internal constant SOLANA_TOKEN_OUT =
        0x9f1b3a0d7c25e48af6b1d0c39e7a2b5148d6c03f21aeb97d4e5c8f60a3b7d219;

    uint128 internal constant DEFAULT_AMOUNT_OUT = 99 * 1e6;

    /// @dev The order owner, deliberately distinct from every address that pranks a call
    ///      here, so `OrderParams.sender` cannot be satisfied by `msg.sender`.
    address internal constant ORDER_OWNER = address(0xabc0110001);
    /// @dev Stands in for a relayer or the Permit2Proxy: it calls the facet but owns
    ///      neither the order nor the refunds.
    address internal constant RELAYER = address(0xabc0110002);
    /// @dev An exclusively entitled solver. Address-shaped because the destination is EVM.
    bytes32 internal constant SOLVER = bytes32(uint256(uint160(0xabc0110003)));

    error OrderOpenedNotEmitted();

    /// @dev The non-indexed half of `OrderOpened`, in event order.
    struct OrderOpenedData {
        bytes32 orderId;
        address funder;
        address tokenIn;
        uint128 amountIn;
        bytes32 tokenOut;
        uint128 amountOut;
        uint32 fillDeadline;
    }

    struct OpenedOrder {
        bytes32 orderId;
        address funder;
        address sender;
        address tokenIn;
        uint128 amountIn;
        uint32 destChainId;
        bytes32 tokenOut;
        uint128 amountOut;
        bytes32 solver;
        uint32 fillDeadline;
    }

    TestM0Facet internal m0Facet;
    M0Facet.M0Data internal validM0Data;

    function setUp() public {
        // 2026-09, well after the OrderBook went live on mainnet and while the Base and
        // Solana lanes are enabled (asserted below so a re-pin fails loudly here).
        customBlockNumberForForking = 26000000;
        initTestBase();

        m0Facet = new TestM0Facet(ORDER_BOOK);

        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = m0Facet.startBridgeTokensViaM0.selector;
        functionSelectors[1] = m0Facet.swapAndStartBridgeTokensViaM0.selector;
        functionSelectors[2] = m0Facet.addAllowedContractSelector.selector;
        functionSelectors[3] = m0Facet.removeAllowedContractSelector.selector;

        addFacet(diamond, address(m0Facet), functionSelectors);
        m0Facet = TestM0Facet(address(diamond));

        m0Facet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        m0Facet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        m0Facet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );
        m0Facet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactTokens.selector
        );

        setFacetAddressInTestBase(address(m0Facet), "M0Facet");

        vm.label(address(ORDER_BOOK), "M0_ORDER_BOOK");
        vm.label(ORDER_OWNER, "M0_ORDER_OWNER");
        vm.label(RELAYER, "RELAYER");

        // pinned-block guards
        assertTrue(ORDER_BOOK.isDestinationSupported(uint32(DEST_CHAIN_ID)));
        assertTrue(ORDER_BOOK.isDestinationSupported(M0_CHAIN_ID_SOLANA));
        assertFalse(IM0OrderBookState(address(ORDER_BOOK)).paused());

        bridgeData.bridge = "m0";
        bridgeData.destinationChainId = DEST_CHAIN_ID;

        validM0Data = M0Facet.M0Data({
            receiverAddress: bytes32(uint256(uint160(USER_RECEIVER))),
            refundRecipient: USER_REFUND,
            orderOwner: ORDER_OWNER,
            tokenOut: TOKEN_OUT,
            solver: bytes32(0),
            amountOut: DEFAULT_AMOUNT_OUT,
            fillDeadline: uint32(block.timestamp + 1 days)
        });
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        m0Facet.startBridgeTokensViaM0(bridgeData, validM0Data);
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        uint256 value = isNative ? swapData[0].fromAmount : 0;

        m0Facet.swapAndStartBridgeTokensViaM0{ value: value }(
            bridgeData,
            swapData,
            validM0Data
        );
    }

    // --- Native source asset is rejected by `noNativeAsset` on both entrypoints ---

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_Revert_BridgeToSameChainId() public override {
        // not applicable — same-chain M0 orders are intentionally supported
    }

    function testBase_Revert_SwapAndBridgeToSameChainId() public override {
        // not applicable — same-chain M0 orders are intentionally supported
    }

    // --- Constructor ---

    function test_CanDeployFacet() public {
        M0Facet facet = new M0Facet(ORDER_BOOK);

        assertEq(address(facet.M0_ORDER_BOOK()), address(ORDER_BOOK));
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new M0Facet(IM0OrderBook(address(0)));
    }

    // --- Escrow post-conditions ---

    function test_WillEscrowSendingAssetAndStoreOrder() public {
        uint256 orderBookBalanceBefore = usdc.balanceOf(address(ORDER_BOOK));

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.recordLogs();

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();

        assertEq(
            usdc.balanceOf(address(ORDER_BOOK)),
            orderBookBalanceBefore + bridgeData.minAmount
        );

        // the whole deposit must move into escrow, never linger in the diamond
        assertEq(usdc.balanceOf(address(diamond)), 0);

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(opened.funder, address(m0Facet));
        assertEq(opened.sender, validM0Data.orderOwner);
        assertEq(opened.tokenIn, ADDRESS_USDC);
        assertEq(uint256(opened.amountIn), bridgeData.minAmount);
        assertEq(uint256(opened.destChainId), DEST_CHAIN_ID);
        assertEq(opened.tokenOut, TOKEN_OUT);
        assertEq(uint256(opened.amountOut), uint256(DEFAULT_AMOUNT_OUT));
        assertEq(opened.solver, bytes32(0));
        assertEq(uint256(opened.fillDeadline), validM0Data.fillDeadline);

        IM0OrderBookState.Order memory order = IM0OrderBookState(
            address(ORDER_BOOK)
        ).getOrder(opened.orderId);
        assertEq(uint256(order.status), uint256(ORDER_STATUS_OPENED));
        assertEq(order.sender, validM0Data.orderOwner);
        assertEq(uint256(order.destChainId), DEST_CHAIN_ID);
        assertEq(uint256(order.fillDeadline), validM0Data.fillDeadline);
        assertEq(order.tokenIn, ADDRESS_USDC);
        assertEq(order.tokenOut, TOKEN_OUT);
        assertEq(uint256(order.amountIn), bridgeData.minAmount);
        assertEq(uint256(order.amountOut), uint256(DEFAULT_AMOUNT_OUT));
        assertEq(order.recipient, validM0Data.receiverAddress);
        assertEq(order.solver, bytes32(0));
    }

    /// @dev The order owner is an M0Data field, not the caller: a relayer or the
    ///      Permit2Proxy may open the order while the user owns it (and its refund).
    function test_WillOpenOrderForOrderOwnerWhenCalledByRelayer() public {
        deal(ADDRESS_USDC, RELAYER, bridgeData.minAmount);

        vm.startPrank(RELAYER);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.recordLogs();

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(opened.funder, address(m0Facet));
        assertEq(opened.sender, ORDER_OWNER);
        assertNotEq(opened.sender, RELAYER);

        IM0OrderBookState.Order memory order = IM0OrderBookState(
            address(ORDER_BOOK)
        ).getOrder(opened.orderId);
        assertEq(order.sender, ORDER_OWNER);
        assertNotEq(order.sender, RELAYER);
    }

    function test_WillOpenOrderForExclusiveSolver() public {
        vm.startPrank(USER_SENDER);

        validM0Data.solver = SOLVER;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.recordLogs();

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(opened.solver, SOLVER);

        IM0OrderBookState.Order memory order = IM0OrderBookState(
            address(ORDER_BOOK)
        ).getOrder(opened.orderId);
        assertEq(order.solver, SOLVER);
    }

    // --- amountOut scaling on the swap path ---

    function test_WillKeepQuotedAmountOutWhenSwapMatchesQuote() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        uint256 realizedAmount = _setSwapDataExactDAIIn(100 * 1e18);
        // quote == realized output, so the limit price must pass through untouched
        bridgeData.minAmount = realizedAmount;

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.recordLogs();

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(uint256(opened.amountIn), realizedAmount);
        assertEq(uint256(opened.amountOut), uint256(DEFAULT_AMOUNT_OUT));
    }

    /// @dev Also covers the escrow post-conditions of the swap path: what gets escrowed
    ///      is the realized swap output, not the quoted `bridgeData.minAmount`.
    function test_WillScaleAmountOutOnPositiveSlippage() public {
        uint256 orderBookBalanceBefore = usdc.balanceOf(address(ORDER_BOOK));

        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        // 200 DAI buys roughly 199 USDC while the quote only promised 100 USDC
        uint256 realizedAmount = _setSwapDataExactDAIIn(200 * 1e18);
        bridgeData.minAmount = defaultUSDCAmount;

        assertGt(realizedAmount, defaultUSDCAmount);

        uint256 expectedAmountOut = (uint256(DEFAULT_AMOUNT_OUT) *
            realizedAmount) / defaultUSDCAmount;

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.recordLogs();

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();

        assertEq(
            usdc.balanceOf(address(ORDER_BOOK)),
            orderBookBalanceBefore + realizedAmount
        );

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(opened.tokenIn, ADDRESS_USDC);
        assertEq(opened.sender, ORDER_OWNER);
        assertEq(uint256(opened.amountIn), realizedAmount);
        assertGt(uint256(opened.amountOut), uint256(DEFAULT_AMOUNT_OUT));
        assertEq(uint256(opened.amountOut), expectedAmountOut);
    }

    /// @dev `scaledAmountOut` can only truncate to zero if the realized swap output is
    ///      smaller than the quote it is scaled against, and `_depositAndSwap` rejects
    ///      that case first — so a zero `amountOut` is the only way into this branch.
    ///      The test below pins that floor, which is what makes it the only way.
    function testRevert_WhenScaledAmountOutIsZero() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        validM0Data.amountOut = 0;

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidAmount.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwapOutputFallsBelowTheQuote() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        uint256 realizedAmount = _setSwapDataExactDAIIn(100 * 1e18);
        // quote twice what the swap can realize: scaling would truncate amountOut, but
        // the swap helper's floor rejects the shortfall before the facet scales anything
        bridgeData.minAmount = realizedAmount * 2;
        validM0Data.amountOut = 1;

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                CumulativeSlippageTooHigh.selector,
                realizedAmount * 2,
                realizedAmount
            )
        );

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- Same-chain orders ---

    function test_CanOpenSameChainOrder() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = block.chainid;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        vm.recordLogs();

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(uint256(opened.destChainId), block.chainid);
    }

    function test_CanSwapAndOpenSameChainOrder() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = block.chainid;
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.recordLogs();

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(uint256(opened.destChainId), block.chainid);
    }

    // --- Non-EVM destinations ---

    function test_CanOpenOrderToSolana() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validM0Data.receiverAddress = SOLANA_RECEIVER;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            SOLANA_RECEIVER
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        vm.recordLogs();

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(uint256(opened.destChainId), uint256(M0_CHAIN_ID_SOLANA));

        IM0OrderBookState.Order memory order = IM0OrderBookState(
            address(ORDER_BOOK)
        ).getOrder(opened.orderId);
        assertEq(order.recipient, SOLANA_RECEIVER);
        assertEq(uint256(order.destChainId), uint256(M0_CHAIN_ID_SOLANA));
    }

    function test_CanSwapAndOpenOrderToSolana() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.hasSourceSwaps = true;
        validM0Data.receiverAddress = SOLANA_RECEIVER;
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit BridgeToNonEVMChainBytes32(
            bridgeData.transactionId,
            LIFI_CHAIN_ID_SOLANA,
            SOLANA_RECEIVER
        );

        vm.recordLogs();

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(uint256(opened.destChainId), uint256(M0_CHAIN_ID_SOLANA));
    }

    /// @dev A Solana destination must use the NON_EVM_ADDRESS sentinel. A plain EVM
    ///      receiver would be left-padded into a bytes32 that means nothing on Solana,
    ///      escrowing into an unfillable order and skipping BridgeToNonEVMChainBytes32.
    function testRevert_WhenSolanaDestinationCarriesEVMReceiver() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.receiver = USER_RECEIVER;
        validM0Data.receiverAddress = bytes32(uint256(uint160(USER_RECEIVER)));

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @dev The sentinel must not be usable on an EVM destination: it would skip the
    ///      receiverAddress equality check and let the escrow recipient point anywhere,
    ///      while LiFiTransferStarted still reported the sentinel.
    function testRevert_WhenEVMDestinationUsesNonEVMSentinel() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        validM0Data.receiverAddress = bytes32(
            uint256(uint160(address(0xdead)))
        );

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenNonEVMReceiverIsZero() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validM0Data.receiverAddress = bytes32(0);

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenNonEVMReceiverIsZeroOnSwapPath() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        bridgeData.hasSourceSwaps = true;
        validM0Data.receiverAddress = bytes32(0);
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidNonEVMReceiver.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @dev Only Solana is translated; every other LI.FI non-EVM id is far wider than
    ///      uint32, so the cast rejects it instead of opening an unfillable order.
    function testRevert_WhenBridgingToUntranslatedNonEVMChain() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_TRON;
        validM0Data.receiverAddress = SOLANA_RECEIVER;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        // Solana is the only non-EVM destination the facet translates, so the sentinel is
        // rejected outright here rather than reaching the uint32 narrowing
        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenDestinationChainIdExceedsUint32() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = uint256(type(uint32).max) + 1;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(SafeCastLib.Overflow.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- M0Data validation ---

    function testRevert_WhenRefundRecipientIsZero() public {
        vm.startPrank(USER_SENDER);

        validM0Data.refundRecipient = address(0);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenRefundRecipientIsZeroOnSwapPath() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        validM0Data.refundRecipient = address(0);
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenOrderOwnerIsZero() public {
        vm.startPrank(USER_SENDER);

        validM0Data.orderOwner = address(0);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenOrderOwnerIsZeroOnSwapPath() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        validM0Data.orderOwner = address(0);
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenTokenOutIsZero() public {
        vm.startPrank(USER_SENDER);

        validM0Data.tokenOut = bytes32(0);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenTokenOutIsZeroOnSwapPath() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        validM0Data.tokenOut = bytes32(0);
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @dev On an EVM destination the OrderBook narrows tokenOut with
    ///      TypeConverter.toAddress when a solver fills. A value with non-zero high bytes
    ///      opens and escrows fine, then reverts every fill, stranding the deposit until
    ///      fillDeadline — so the facet rejects it up front.
    function testRevert_WhenEVMTokenOutIsNotAnAddress() public {
        vm.startPrank(USER_SENDER);

        validM0Data.tokenOut = SOLANA_TOKEN_OUT;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                LibBytes.NotAnAddress.selector,
                SOLANA_TOKEN_OUT
            )
        );

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenEVMTokenOutIsNotAnAddressOnSwapPath() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        validM0Data.tokenOut = SOLANA_TOKEN_OUT;
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                LibBytes.NotAnAddress.selector,
                SOLANA_TOKEN_OUT
            )
        );

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// @dev The guard above must not reach non-EVM destinations: an SPL mint legitimately
    ///      uses all 32 bytes.
    function test_CanOpenOrderToSolanaWithFullWidthTokenOut() public {
        vm.startPrank(USER_SENDER);

        bridgeData.receiver = NON_EVM_ADDRESS;
        bridgeData.destinationChainId = LIFI_CHAIN_ID_SOLANA;
        validM0Data.receiverAddress = SOLANA_RECEIVER;
        validM0Data.tokenOut = SOLANA_TOKEN_OUT;

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.recordLogs();

        initiateBridgeTxWithFacet(false);

        vm.stopPrank();

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(opened.tokenOut, SOLANA_TOKEN_OUT);

        IM0OrderBookState.Order memory order = IM0OrderBookState(
            address(ORDER_BOOK)
        ).getOrder(opened.orderId);
        assertEq(order.tokenOut, SOLANA_TOKEN_OUT);
    }

    function testRevert_WhenReceiverAddressDoesNotMatchBridgeData() public {
        vm.startPrank(USER_SENDER);

        validM0Data.receiverAddress = bytes32(uint256(uint160(USER_REFUND)));
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenReceiverAddressDoesNotMatchOnSwapPath() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        validM0Data.receiverAddress = bytes32(uint256(uint160(USER_REFUND)));
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InformationMismatch.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenLastSwapDoesNotReturnSendingAsset() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = ADDRESS_DAI;
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InformationMismatch.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- Refund routing ([CONV:FACET-REFUNDS]) ---

    /// @dev The swap entrypoint takes no native fee, so every wei sent is excess and must
    ///      land at the refundRecipient rather than at the caller.
    function test_WillRefundExcessNativeToRefundRecipient() public {
        uint256 excess = 0.002 ether;

        uint256 refundBalanceBefore = USER_REFUND.balance;
        uint256 senderBalanceBefore = USER_SENDER.balance;

        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        m0Facet.swapAndStartBridgeTokensViaM0{ value: excess }(
            bridgeData,
            swapData,
            validM0Data
        );

        vm.stopPrank();

        assertEq(USER_REFUND.balance, refundBalanceBefore + excess);
        assertEq(USER_SENDER.balance, senderBalanceBefore - excess);
        assertEq(address(diamond).balance, 0);
    }

    /// @dev An exact-output swap consumes less input than it was funded with; the
    ///      leftover is the user's and goes to the refundRecipient, not to the caller.
    function test_WillRefundLeftoverSwapInputToRefundRecipient() public {
        uint256 refundBalanceBefore = dai.balanceOf(USER_REFUND);
        uint256 senderBalanceBefore = dai.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        (
            uint256 amountInMax,
            uint256 amountInRequired
        ) = _setSwapDataExactUSDCOut(defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;

        uint256 expectedLeftover = amountInMax - amountInRequired;
        assertGt(expectedLeftover, 0);

        dai.approve(_facetTestContractAddress, amountInMax);

        vm.recordLogs();

        initiateSwapAndBridgeTxWithFacet(false);

        vm.stopPrank();

        assertEq(
            dai.balanceOf(USER_REFUND),
            refundBalanceBefore + expectedLeftover
        );
        assertEq(
            dai.balanceOf(USER_SENDER),
            senderBalanceBefore - amountInMax
        );
        assertEq(dai.balanceOf(address(diamond)), 0);

        OpenedOrder memory opened = _lastOpenedOrder();
        assertEq(uint256(opened.amountIn), defaultUSDCAmount);
    }

    // --- Native asset ---

    function testRevert_WhenBridgingNativeAsset() public {
        vm.startPrank(USER_SENDER);

        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;

        vm.expectRevert(NativeAssetNotSupported.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwappingIntoNativeAsset() public {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = defaultNativeAmount;
        setDefaultSwapDataSingleDAItoETH();

        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(NativeAssetNotSupported.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- Rules the facet deliberately leaves to the OrderBook ---

    function testRevert_WhenDestinationChainIsNotSupported() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = 137; // Polygon, not enabled on the OrderBook
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(IM0OrderBookState.InvalidDestinationChain.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenAmountOutIsZero() public {
        vm.startPrank(USER_SENDER);

        validM0Data.amountOut = 0;
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(IM0OrderBookState.AmountOutZero.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenFillDeadlineHasPassed() public {
        vm.startPrank(USER_SENDER);

        validM0Data.fillDeadline = uint32(block.timestamp - 1);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(IM0OrderBookState.InvalidDeadline.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSameChainOrderKeepsTheSameToken() public {
        vm.startPrank(USER_SENDER);

        bridgeData.destinationChainId = block.chainid;
        validM0Data.tokenOut = bytes32(uint256(uint160(ADDRESS_USDC)));

        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(IM0OrderBookState.SameTokenOrder.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    // --- Helpers ---

    /// @dev Builds a single DAI -> USDC swap for an exact DAI input and returns the
    ///      USDC the pool will actually hand back at the pinned block.
    function _setSwapDataExactDAIIn(
        uint256 _amountIn
    ) internal returns (uint256 amountOutQuoted) {
        delete swapData;

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        amountOutQuoted = uniswap.getAmountsOut(_amountIn, path)[1];

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: _amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    _amountIn,
                    amountOutQuoted,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    /// @dev Builds a single DAI -> USDC swap for an exact USDC output, funded with more
    ///      DAI than the pool needs so the swap leaves a leftover input to refund.
    /// @param _amountOut The exact USDC the swap must return
    /// @return amountInMax The DAI the swap is funded with
    /// @return amountInRequired The DAI the pool actually takes at the pinned block
    function _setSwapDataExactUSDCOut(
        uint256 _amountOut
    ) internal returns (uint256 amountInMax, uint256 amountInRequired) {
        delete swapData;

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;

        amountInRequired = uniswap.getAmountsIn(_amountOut, path)[0];
        amountInMax = (amountInRequired * 3) / 2;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountInMax,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactTokens.selector,
                    _amountOut,
                    amountInMax,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function _lastOpenedOrder()
        internal
        view
        returns (OpenedOrder memory opened)
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 i = logs.length; i > 0; --i) {
            Vm.Log memory entry = logs[i - 1];

            if (
                entry.emitter != address(ORDER_BOOK) ||
                entry.topics.length != 4 ||
                entry.topics[0] != ORDER_OPENED_TOPIC
            ) {
                continue;
            }

            OrderOpenedData memory data = abi.decode(
                entry.data,
                (OrderOpenedData)
            );

            opened.orderId = data.orderId;
            opened.funder = data.funder;
            opened.tokenIn = data.tokenIn;
            opened.amountIn = data.amountIn;
            opened.tokenOut = data.tokenOut;
            opened.amountOut = data.amountOut;
            opened.fillDeadline = data.fillDeadline;
            opened.sender = address(uint160(uint256(entry.topics[1])));
            opened.destChainId = uint32(uint256(entry.topics[2]));
            opened.solver = entry.topics[3];

            return opened;
        }

        revert OrderOpenedNotEmitted();
    }
}
