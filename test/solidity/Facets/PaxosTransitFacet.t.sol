// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { TestPaxosTransitBackendSig } from "../utils/TestPaxosTransitBackendSig.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { PaxosTransitFacet } from "lifi/Facets/PaxosTransitFacet.sol";
import { IPaxosTransit } from "lifi/Interfaces/IPaxosTransit.sol";
import { InformationMismatch, InvalidCallData, InvalidConfig, NativeAssetNotSupported, CumulativeSlippageTooHigh } from "lifi/Errors/GenericErrors.sol";

/// Config/admin/state surface of the real TransitStation needed to run fork tests
/// against it (rotate the quote signer, quote the LZ fee, inspect order state).
/// Mirrors the verified mainnet deployment at 0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28.
interface ITransitStation {
    struct OrderTerms {
        bytes32 uuid;
        address wantAsset;
        address receiver;
        address offerAsset;
        uint256 offerAmountNormalized18AfterFees;
    }

    error QuoteExpired(uint256 deadline);
    error InvalidSigner(address recoveredSigner);
    error SignatureAlreadyUsed(bytes32 digest);

    function owner() external view returns (address);

    function setQuoteSigner(address signer) external;

    function quoteSigner() external view returns (address);

    function quoteSend(
        uint32 destEID,
        OrderTerms calldata terms
    ) external view returns (uint256);

    function usedDigests(bytes32 digest) external view returns (bool);

    function approvedRoutes(
        uint32 destEID,
        address offerAsset,
        address wantAsset
    ) external view returns (bool);

    function messageGasLimit(uint32 eid) external view returns (uint64);

    function offerReceiver() external view returns (address);

    function protocolFeeRecipient() external view returns (address);
}

/// LayerZero EndpointV2 error raised when submitOrder forwards less native than the
/// quoted messaging fee.
interface ILayerZeroEndpointV2Errors {
    error LZ_InsufficientFee(
        uint256 requiredNative,
        uint256 suppliedNative,
        uint256 requiredLzToken,
        uint256 suppliedLzToken
    );
}

// Stub PaxosTransitFacet Contract
contract TestPaxosTransitFacet is PaxosTransitFacet, TestWhitelistManagerBase {
    constructor(
        IPaxosTransit _transitStation
    ) PaxosTransitFacet(_transitStation) {}
}

contract PaxosTransitFacetTest is TestBaseFacet, TestPaxosTransitBackendSig {
    // left-adjusted bytes32 encoding of "LIFI"
    bytes32 internal constant LIFI_DISTRIBUTOR_CODE =
        0x4c49464900000000000000000000000000000000000000000000000000000000;
    uint256 internal constant DEST_CHAIN_ID = 4663; // Robinhood Chain
    uint32 internal constant DEST_EID = 30416; // LayerZero EID for Robinhood Chain

    // the real Paxos TransitStation on mainnet (verified 2026-06-29)
    ITransitStation internal constant TRANSIT_STATION =
        ITransitStation(0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28);
    // want asset of the globally-approved USDC route to Robinhood (USDG); taken from the
    // station's on-chain RouteApprovalSet/OrderSubmitted events - the route allowlist is
    // keyed on it, so an arbitrary placeholder would revert with RouteNotApproved
    address internal constant WANT_ASSET =
        0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    PaxosTransitFacet.PaxosTransitData internal validPaxosData;
    TestPaxosTransitFacet internal paxosFacet;

    function setUp() public {
        // 2026-07-03, after Paxos approved the USDC -> USDG route to EID 30416, set its
        // LZ gas limit and wired the Robinhood peer (real orders flow at 25449164)
        customBlockNumberForForking = 25449200;
        initTestBase();

        quoteSignerPk = 0xA11CE;
        quoteSignerAddress = vm.addr(quoteSignerPk);

        // the station gates submitOrder on a Paxos-controlled quote signer; rotate it to a
        // test key on the fork (plain storage, owner-gated setter) so quotes can be signed
        // in-test against the station's live EIP-712 domain
        vm.prank(TRANSIT_STATION.owner());
        TRANSIT_STATION.setQuoteSigner(quoteSignerAddress);

        // pinned-block guards: fail loudly here (not deep in a funds-flow assert) if a
        // re-pin lands on a block where Paxos has not configured the route yet
        assertTrue(
            TRANSIT_STATION.approvedRoutes(DEST_EID, ADDRESS_USDC, WANT_ASSET)
        );
        assertGt(TRANSIT_STATION.messageGasLimit(DEST_EID), 0);
        assertEq(TRANSIT_STATION.quoteSigner(), quoteSignerAddress);

        paxosFacet = new TestPaxosTransitFacet(
            IPaxosTransit(address(TRANSIT_STATION))
        );
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = paxosFacet
            .startBridgeTokensViaPaxosTransit
            .selector;
        functionSelectors[1] = paxosFacet
            .swapAndStartBridgeTokensViaPaxosTransit
            .selector;
        functionSelectors[2] = paxosFacet.addAllowedContractSelector.selector;
        functionSelectors[3] = paxosFacet
            .removeAllowedContractSelector
            .selector;

        addFacet(diamond, address(paxosFacet), functionSelectors);
        paxosFacet = TestPaxosTransitFacet(address(diamond));
        paxosFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        paxosFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        paxosFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(paxosFacet), "PaxosTransitFacet");

        // adjust bridgeData
        bridgeData.bridge = "paxosTransit";
        bridgeData.destinationChainId = DEST_CHAIN_ID;

        // produce valid PaxosTransitData matching the default bridgeData; the signature
        // is produced per-call in the initiate* helpers so quote mutations stay signed
        validPaxosData = PaxosTransitFacet.PaxosTransitData({
            quote: IPaxosTransit.Quote({
                route: IPaxosTransit.Route({
                    destEID: DEST_EID,
                    offerAsset: ADDRESS_USDC,
                    wantAsset: WANT_ASSET
                }),
                offerAmount: defaultUSDCAmount,
                receiver: USER_RECEIVER,
                protocolFee: 0,
                integratorFee: 0,
                integratorFeeReceiver: address(0),
                distributorCode: LIFI_DISTRIBUTOR_CODE,
                deadline: block.timestamp + 5 minutes,
                salt: keccak256("paxos-salt")
            }),
            signature: hex"",
            nativeFee: _lzNativeFee(),
            refundRecipient: USER_REFUND
        });
    }

    /// @dev The real LZ messaging fee for bridging an order to DEST_EID. The bridged
    ///      OrderTerms payload is fixed-size, so the fee is independent of the quote's
    ///      values and one setUp-time fetch covers every test (incl. fuzzed amounts).
    function _lzNativeFee() internal view returns (uint256) {
        return
            TRANSIT_STATION.quoteSend(
                DEST_EID,
                ITransitStation.OrderTerms({
                    uuid: bytes32(0),
                    wantAsset: WANT_ASSET,
                    receiver: USER_RECEIVER,
                    offerAsset: ADDRESS_USDC,
                    offerAmountNormalized18AfterFees: 0
                })
            );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        // sign the (possibly test-mutated) quote as the LI.FI backend would; tests that
        // need a broken or foreign signature call the facet directly instead
        validPaxosData.signature = _signPaxosQuote(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        if (isNative) {
            paxosFacet.startBridgeTokensViaPaxosTransit{
                value: bridgeData.minAmount
            }(bridgeData, validPaxosData);
        } else {
            paxosFacet.startBridgeTokensViaPaxosTransit{
                value: validPaxosData.nativeFee
            }(bridgeData, validPaxosData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        validPaxosData.signature = _signPaxosQuote(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        if (isNative) {
            paxosFacet.swapAndStartBridgeTokensViaPaxosTransit{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validPaxosData);
        } else {
            paxosFacet.swapAndStartBridgeTokensViaPaxosTransit{
                value: validPaxosData.nativeFee
            }(bridgeData, swapData, validPaxosData);
        }
    }

    // keep the signed quote's offerAmount aligned with the fuzzed bridge amount
    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** usdc.decimals();
        validPaxosData.quote.offerAmount = amount;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, amount);

        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = amount;

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function test_WillStoreConstructorParametersCorrectly() public {
        paxosFacet = new TestPaxosTransitFacet(
            IPaxosTransit(address(TRANSIT_STATION))
        );

        assertEq(
            address(paxosFacet.TRANSIT_STATION()),
            address(TRANSIT_STATION)
        );
        assertEq(paxosFacet.LIFI_DISTRIBUTOR_CODE(), LIFI_DISTRIBUTOR_CODE);
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestPaxosTransitFacet(IPaxosTransit(address(0)));
    }

    function testRevert_WhenTryToBridgeNativeAsset() public {
        vm.startPrank(USER_SENDER);
        bridgeData.sendingAssetId = address(0);

        vm.expectRevert(NativeAssetNotSupported.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenTryToSwapAndBridgeNativeAsset() public {
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        bridgeData.sendingAssetId = address(0);

        setDefaultSwapDataSingleDAItoUSDC();

        vm.expectRevert(NativeAssetNotSupported.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenOfferAssetMismatchesQuote() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPaxosData.quote.route.offerAsset = ADDRESS_DAI;

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenOfferAmountMismatchesQuote() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPaxosData.quote.offerAmount = defaultUSDCAmount + 1;

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwapAndBridgeOfferAmountMismatchesQuote() public {
        // guards the swap floor: without this check a zero/low signed offerAmount would
        // bypass the validateBridgeData non-zero minAmount guarantee
        validPaxosData.quote.offerAmount = defaultUSDCAmount + 1;

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InformationMismatch.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenReceiverMismatchesQuote() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPaxosData.quote.receiver = USER_SENDER;

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenDistributorCodeMismatchesQuote() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPaxosData.quote.distributorCode = bytes32("WRONG");

        vm.expectRevert(InformationMismatch.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_BridgeSubmitsOrderToRealStation() public {
        // EXSC-547 core question: the station pulls the offer asset from msg.sender, which
        // is the Diamond when our facet calls submitOrder. We custody in the Diamond
        // (depositAsset) and approve the station, so funds flow USER -> Diamond -> Paxos.
        // The station custodies nothing: with a zero-fee quote the full offer amount lands
        // at its offerReceiver. quote.receiver (validated == bridgeData.receiver) directs
        // the want asset to the end user on the destination chain.
        bytes32 digest = _paxosQuoteDigest(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );
        address offerReceiver = TRANSIT_STATION.offerReceiver();
        uint256 offerReceiverBefore = usdc.balanceOf(offerReceiver);
        uint256 senderUsdcBefore = usdc.balanceOf(USER_SENDER);
        uint256 senderNativeBefore = USER_SENDER.balance;

        assertFalse(TRANSIT_STATION.usedDigests(digest));

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(
            usdc.balanceOf(USER_SENDER),
            senderUsdcBefore - defaultUSDCAmount
        );
        assertEq(
            usdc.balanceOf(offerReceiver),
            offerReceiverBefore + defaultUSDCAmount
        );
        // nothing stranded in the Diamond, and the exact quoteSend fee was consumed by
        // LayerZero (no overage came back, no refund was owed)
        assertEq(usdc.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
        assertEq(
            USER_SENDER.balance,
            senderNativeBefore - validPaxosData.nativeFee
        );
        // the order is registered: its EIP-712 digest (== order uuid) is marked used
        assertTrue(TRANSIT_STATION.usedDigests(digest));
        // receiver (end user) is taken from the signed quote, not from msg.sender
        assertEq(validPaxosData.quote.receiver, bridgeData.receiver);
        assertTrue(bridgeData.receiver != address(diamond));
    }

    function test_CanBridgeTokensWithNonZeroFees() public {
        // protocolFee / integratorFee live in the signed quote; the station splits the
        // pulled offerAmount into protocolFee -> protocolFeeRecipient, integratorFee ->
        // integratorFeeReceiver and net -> offerReceiver (caps: 50 bps / 10%)
        uint256 protocolFee = 0.02 * 10 ** 6;
        uint256 integratorFee = 0.5 * 10 ** 6;
        address integratorFeeReceiver = address(0xFee1);
        validPaxosData.quote.protocolFee = protocolFee;
        validPaxosData.quote.integratorFee = integratorFee;
        validPaxosData.quote.integratorFeeReceiver = integratorFeeReceiver;

        address offerReceiver = TRANSIT_STATION.offerReceiver();
        address protocolFeeRecipient = TRANSIT_STATION.protocolFeeRecipient();
        // at the pinned block Paxos points both at the same address; guard so a re-pin
        // that breaks this assumption fails here, not in the combined balance assert
        assertEq(offerReceiver, protocolFeeRecipient);
        uint256 combinedBefore = usdc.balanceOf(offerReceiver);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        uint256 net = defaultUSDCAmount - protocolFee - integratorFee;
        assertEq(usdc.balanceOf(integratorFeeReceiver), integratorFee);
        assertEq(
            usdc.balanceOf(offerReceiver),
            combinedBefore + protocolFee + net
        );
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    function testRevert_WhenQuoteIsReplayed() public {
        // the station consumes the quote's EIP-712 digest on first submission; replaying
        // the same signed quote must revert (the digest doubles as the order uuid)
        bytes32 digest = _paxosQuoteDigest(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, 2 * bridgeData.minAmount);

        initiateBridgeTxWithFacet(false);

        assertTrue(TRANSIT_STATION.usedDigests(digest));

        vm.expectRevert(
            abi.encodeWithSelector(
                ITransitStation.SignatureAlreadyUsed.selector,
                digest
            )
        );

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenQuoteIsExpired() public {
        validPaxosData.quote.deadline = block.timestamp - 1;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                ITransitStation.QuoteExpired.selector,
                block.timestamp - 1
            )
        );

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenQuoteIsSignedByWrongKey() public {
        // a well-formed signature from any key other than the station's quoteSigner must
        // be rejected; the station reports the recovered (wrong) signer
        uint256 wrongSignerPk = 0xBAD;
        validPaxosData.signature = _signDigest(
            wrongSignerPk,
            _paxosQuoteDigest(validPaxosData.quote, address(TRANSIT_STATION))
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                ITransitStation.InvalidSigner.selector,
                vm.addr(wrongSignerPk)
            )
        );

        paxosFacet.startBridgeTokensViaPaxosTransit{
            value: validPaxosData.nativeFee
        }(bridgeData, validPaxosData);
        vm.stopPrank();
    }

    function testRevert_WhenNativeFeeUnderpaid() public {
        // forwarding less than the quoteSend fee makes the LayerZero endpoint revert,
        // proving the facet forwards exactly nativeFee (the order is not silently accepted)
        uint256 quotedFee = validPaxosData.nativeFee;
        validPaxosData.nativeFee = quotedFee - 1;
        validPaxosData.signature = _signPaxosQuote(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                ILayerZeroEndpointV2Errors.LZ_InsufficientFee.selector,
                quotedFee,
                quotedFee - 1,
                0,
                0
            )
        );

        paxosFacet.startBridgeTokensViaPaxosTransit{ value: quotedFee - 1 }(
            bridgeData,
            validPaxosData
        );
        vm.stopPrank();
    }

    function test_LzFeeOverageIsRefundedToRefundRecipient() public {
        // when nativeFee overshoots the real LZ fee, the endpoint refunds the overage to
        // the Diamond mid-call; refundExcessNative must pass it on to the refundRecipient
        // (this is the flow the facet's refundRecipient NatSpec documents)
        uint256 overage = 0.001 ether;
        validPaxosData.nativeFee += overage;

        uint256 refundNativeBefore = USER_REFUND.balance;
        uint256 senderNativeBefore = USER_SENDER.balance;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(USER_REFUND.balance, refundNativeBefore + overage);
        assertEq(
            USER_SENDER.balance,
            senderNativeBefore - validPaxosData.nativeFee
        );
        assertEq(address(diamond).balance, 0);
    }

    function testRevert_WhenSwapOutputBelowOfferAmount() public {
        // the quote's offerAmount is the swap floor; a swap yielding less must revert
        validPaxosData.quote.offerAmount = defaultUSDCAmount + 1;
        bridgeData.minAmount = defaultUSDCAmount + 1;

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(
            abi.encodeWithSelector(
                CumulativeSlippageTooHigh.selector,
                defaultUSDCAmount + 1,
                defaultUSDCAmount
            )
        );

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_SwapAndBridgeRefundsPositiveSlippage() public {
        uint256 offerAmount = defaultUSDCAmount - 1 * 10 ** usdc.decimals();
        validPaxosData.quote.offerAmount = offerAmount;
        bridgeData.minAmount = offerAmount;

        address offerReceiver = TRANSIT_STATION.offerReceiver();
        uint256 offerReceiverBefore = usdc.balanceOf(offerReceiver);

        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        uint256 senderUsdcBefore = usdc.balanceOf(USER_SENDER);

        // the emitted (and bridged) amount is the quote's offerAmount (== minAmount),
        // even though the swap yields more
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        // only the exact (lower) offer amount is pulled by the station
        assertEq(
            usdc.balanceOf(offerReceiver),
            offerReceiverBefore + offerAmount
        );
        // the positive slippage (swap output - offer amount) is refunded to the designated
        // refundRecipient, NOT to msg.sender (which may be a relayer or the Permit2Proxy)
        assertEq(usdc.balanceOf(USER_REFUND), defaultUSDCAmount - offerAmount);
        assertEq(usdc.balanceOf(USER_SENDER), senderUsdcBefore);
    }

    function testRevert_WhenNativeFeeExceedsMsgValue() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPaxosData.signature = _signPaxosQuote(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        vm.expectRevert(InvalidCallData.selector);

        paxosFacet.startBridgeTokensViaPaxosTransit{
            value: validPaxosData.nativeFee - 1
        }(bridgeData, validPaxosData);
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeWhenNativeFeeIsFundedByPreSwap() public {
        // the LayerZero fee does not have to come from msg.value on the swap path: an
        // ERC20->native pre-swap can fund it, and _depositAndSwap's nativeReserve keeps
        // that native in the diamond for submitOrder instead of sweeping it as leftovers
        uint256 nativeFee = validPaxosData.nativeFee;
        bytes32 digest = _paxosQuoteDigest(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );
        address offerReceiver = TRANSIT_STATION.offerReceiver();
        uint256 offerReceiverBefore = usdc.balanceOf(offerReceiver);

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;

        // final swap must output the offer asset, so the DAI -> native swap goes first
        setDefaultSwapDataSingleDAItoUSDC();
        LibSwap.SwapData memory daiToUsdc = swapData[0];
        delete swapData;

        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;
        uint256 amountInMax = 50 * 10 ** dai.decimals();
        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: amountInMax,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    nativeFee,
                    amountInMax,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
        swapData.push(daiToUsdc);

        dai.approve(
            _facetTestContractAddress,
            amountInMax + daiToUsdc.fromAmount
        );

        validPaxosData.signature = _signPaxosQuote(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        // no native sent at all - the fee is funded entirely by the first swap
        paxosFacet.swapAndStartBridgeTokensViaPaxosTransit{ value: 0 }(
            bridgeData,
            swapData,
            validPaxosData
        );
        vm.stopPrank();

        // the order was accepted by the real station and the offer amount pulled
        assertTrue(TRANSIT_STATION.usedDigests(digest));
        assertEq(
            usdc.balanceOf(offerReceiver),
            offerReceiverBefore + defaultUSDCAmount
        );
        // unspent DAI from the exact-output swap goes to the refundRecipient, not msg.sender
        assertGt(dai.balanceOf(USER_REFUND), 0);
        // nothing stranded in the diamond
        assertEq(address(diamond).balance, 0);
        assertEq(dai.balanceOf(address(diamond)), 0);
    }

    function testRevert_WhenSwapAndBridgeWithZeroRefundRecipient() public {
        validPaxosData.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenBridgeWithZeroRefundRecipient() public {
        // without the explicit guard a zero refundRecipient would only revert late in
        // refundExcessNative, and only if there was excess native to refund
        validPaxosData.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_ExcessNativeIsRefundedToRefundRecipient() public {
        // excess above nativeFee never leaves the facet; refundExcessNative returns it
        uint256 excess = 0.002 ether;

        uint256 refundNativeBefore = USER_REFUND.balance;
        uint256 senderNativeBefore = USER_SENDER.balance;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        validPaxosData.signature = _signPaxosQuote(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        paxosFacet.startBridgeTokensViaPaxosTransit{
            value: validPaxosData.nativeFee + excess
        }(bridgeData, validPaxosData);
        vm.stopPrank();

        // excess native goes to the designated refundRecipient, NOT to msg.sender
        assertEq(USER_REFUND.balance, refundNativeBefore + excess);
        assertEq(
            USER_SENDER.balance,
            senderNativeBefore - validPaxosData.nativeFee - excess
        );
        assertEq(address(diamond).balance, 0);
    }

    function test_SwapAndBridgeRefundsExcessNativeToRefundRecipient() public {
        // everything above the reserved nativeFee is excess native on the swap path
        uint256 excess = 0.002 ether;

        uint256 refundNativeBefore = USER_REFUND.balance;

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        validPaxosData.signature = _signPaxosQuote(
            validPaxosData.quote,
            address(TRANSIT_STATION)
        );

        paxosFacet.swapAndStartBridgeTokensViaPaxosTransit{
            value: validPaxosData.nativeFee + excess
        }(bridgeData, swapData, validPaxosData);
        vm.stopPrank();

        assertEq(USER_REFUND.balance, refundNativeBefore + excess);
        assertEq(address(diamond).balance, 0);
    }
}
