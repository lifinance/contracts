// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { MockTransitStation } from "../utils/MockTransitStation.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { PaxosTransitFacet } from "lifi/Facets/PaxosTransitFacet.sol";
import { IPaxosTransit } from "lifi/Interfaces/IPaxosTransit.sol";
import { InformationMismatch, InvalidCallData, InvalidConfig, NativeAssetNotSupported, CumulativeSlippageTooHigh } from "lifi/Errors/GenericErrors.sol";

// Stub PaxosTransitFacet Contract
contract TestPaxosTransitFacet is PaxosTransitFacet, TestWhitelistManagerBase {
    constructor(
        IPaxosTransit _transitStation
    ) PaxosTransitFacet(_transitStation) {}
}

contract PaxosTransitFacetTest is TestBaseFacet {
    // left-adjusted bytes32 encoding of "LIFI"
    bytes32 internal constant LIFI_DISTRIBUTOR_CODE =
        0x4c49464900000000000000000000000000000000000000000000000000000000;
    uint256 internal constant DEST_CHAIN_ID = 4663; // Robinhood Chain
    uint32 internal constant DEST_EID = 30416; // LayerZero EID for Robinhood Chain
    // arbitrary wantAsset placeholder (USDG on the destination chain); the mock ignores it
    address internal constant WANT_ASSET =
        0x1212121212121212121212121212121212121212;

    PaxosTransitFacet.PaxosTransitData internal validPaxosData;
    TestPaxosTransitFacet internal paxosFacet;
    MockTransitStation internal transitStation;

    function setUp() public {
        customBlockNumberForForking = 17130542;
        initTestBase();

        transitStation = new MockTransitStation();

        paxosFacet = new TestPaxosTransitFacet(
            IPaxosTransit(address(transitStation))
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

        // produce valid PaxosTransitData matching the default bridgeData
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
            nativeFee: 0,
            refundRecipient: USER_REFUND
        });
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
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
            IPaxosTransit(address(transitStation))
        );

        assertEq(
            address(paxosFacet.TRANSIT_STATION()),
            address(transitStation)
        );
        assertEq(paxosFacet.LIFI_DISTRIBUTOR_CODE(), LIFI_DISTRIBUTOR_CODE);
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);
        new TestPaxosTransitFacet(IPaxosTransit(address(0)));
    }

    function test_InterfaceMatchesDeployedStationABI() public pure {
        // Pins our IPaxosTransit.submitOrder selector to the deployed + verified Paxos
        // TransitStation (mainnet/RH 0x49AAA987b1a7e9E4AE091dcD8332c39F322D7d28, verified
        // 2026-06-29). Any drift in the Quote/Route struct layout changes this selector.
        assertEq(IPaxosTransit.submitOrder.selector, bytes4(0x3784896a));
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

    function test_CanBridgeTokensWithNativeFee() public {
        uint256 nativeFee = 0.01 ether;
        validPaxosData.nativeFee = nativeFee;
        // the station requires exactly this LayerZero fee; proves the facet forwards enough
        transitStation.setExpectedNativeFee(nativeFee);

        uint256 senderNativeBefore = USER_SENDER.balance;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        paxosFacet.startBridgeTokensViaPaxosTransit{ value: nativeFee }(
            bridgeData,
            validPaxosData
        );
        vm.stopPrank();

        assertEq(transitStation.lastNativeFee(), nativeFee);
        assertEq(usdc.balanceOf(address(transitStation)), defaultUSDCAmount);
        // no funds come back to / are stranded in the Diamond, and the caller is charged
        // exactly the native fee (no over-charge, no refund needed)
        assertEq(usdc.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
        assertEq(USER_SENDER.balance, senderNativeBefore - nativeFee);
    }

    function test_OfferAssetIsPulledFromTheDiamond() public {
        // EXSC-547 core question: the station pulls the offer asset from msg.sender, which is the
        // Diamond when our facet calls submitOrder. We custody in the Diamond (depositAsset) and
        // approve the station, so funds flow USER -> Diamond -> Station. No submitOrderWithPermit /
        // on-behalf call is needed: Paxos confirmed msg.sender is always the payer, and quote.receiver
        // (validated == bridgeData.receiver) directs the output to the end user.
        uint256 userBefore = usdc.balanceOf(USER_SENDER);

        // sanity: the station can only pull if the Diamond approved it
        assertEq(usdc.allowance(address(diamond), address(transitStation)), 0);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);
        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        // user funded the Diamond; the Diamond (as msg.sender) paid the station; nothing stranded
        assertEq(usdc.balanceOf(USER_SENDER), userBefore - defaultUSDCAmount);
        assertEq(usdc.balanceOf(address(transitStation)), defaultUSDCAmount);
        assertEq(usdc.balanceOf(address(diamond)), 0);
        // receiver (end user) is taken from the signed quote, not from msg.sender
        assertEq(validPaxosData.quote.receiver, bridgeData.receiver);
        assertTrue(bridgeData.receiver != address(diamond));
    }

    function testRevert_WhenNativeFeeUnderpaid() public {
        // station demands more than the facet will forward -> submitOrder reverts,
        // proving the facet forwards exactly nativeFee (and the order is not silently accepted)
        validPaxosData.nativeFee = 0.01 ether;
        transitStation.setExpectedNativeFee(0.01 ether + 1);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(MockTransitStation.InsufficientNativeFee.selector);

        paxosFacet.startBridgeTokensViaPaxosTransit{ value: 0.01 ether }(
            bridgeData,
            validPaxosData
        );
        vm.stopPrank();
    }

    function test_CanBridgeTokensWithNonZeroFees() public {
        // protocolFee / integratorFee live in the signed quote and are deducted by the station
        // from the output; the full offerAmount is still pulled from the Diamond
        validPaxosData.quote.protocolFee = 0.02 * 10 ** 6;
        validPaxosData.quote.integratorFee = 0.5 * 10 ** 6;
        validPaxosData.quote.integratorFeeReceiver = USER_RECEIVER;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(usdc.balanceOf(address(transitStation)), defaultUSDCAmount);
        assertEq(usdc.balanceOf(address(diamond)), 0);
    }

    function testRevert_WhenSwapOutputBelowOfferAmount() public {
        // the quote's offerAmount is the swap floor; a swap yielding less must revert
        validPaxosData.quote.offerAmount = defaultUSDCAmount + 1;

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

        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        dai.approve(_facetTestContractAddress, swapData[0].fromAmount);

        uint256 senderUsdcBefore = usdc.balanceOf(USER_SENDER);

        // the emitted (and bridged) amount must be the quote's offerAmount, not the
        // caller-supplied minAmount (which the swap path overwrites)
        ILiFi.BridgeData memory expectedBridgeData = bridgeData;
        expectedBridgeData.minAmount = offerAmount;
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(expectedBridgeData);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        // only the exact (lower) offer amount is bridged to the station
        assertEq(usdc.balanceOf(address(transitStation)), offerAmount);
        // the positive slippage (swap output - offer amount) is refunded to the designated
        // refundRecipient, NOT to msg.sender (which may be a relayer or the Permit2Proxy)
        assertEq(usdc.balanceOf(USER_REFUND), defaultUSDCAmount - offerAmount);
        assertEq(usdc.balanceOf(USER_SENDER), senderUsdcBefore);
    }

    function testRevert_WhenNativeFeeExceedsMsgValue() public {
        validPaxosData.nativeFee = 0.01 ether;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        paxosFacet.startBridgeTokensViaPaxosTransit{ value: 0.01 ether - 1 }(
            bridgeData,
            validPaxosData
        );
        vm.stopPrank();
    }

    function test_CanSwapAndBridgeWhenNativeFeeIsFundedByPreSwap() public {
        // the LayerZero fee does not have to come from msg.value on the swap path: an
        // ERC20->native pre-swap can fund it, and _depositAndSwap's nativeReserve keeps
        // that native in the diamond for submitOrder instead of sweeping it as leftovers
        uint256 nativeFee = 0.01 ether;
        validPaxosData.nativeFee = nativeFee;
        transitStation.setExpectedNativeFee(nativeFee);

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

        // no native sent at all - the fee is funded entirely by the first swap
        paxosFacet.swapAndStartBridgeTokensViaPaxosTransit{ value: 0 }(
            bridgeData,
            swapData,
            validPaxosData
        );
        vm.stopPrank();

        assertEq(transitStation.lastNativeFee(), nativeFee);
        assertEq(usdc.balanceOf(address(transitStation)), defaultUSDCAmount);
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
}
