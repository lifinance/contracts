// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
import { CentrifugeFacet } from "lifi/Facets/CentrifugeFacet.sol";
import { ICentrifugeTokenBridge } from "lifi/Interfaces/ICentrifugeTokenBridge.sol";
import { ETHTransferFailed, InvalidCallData, InvalidConfig, NativeAssetNotSupported, ReentrancyError, TransferFromFailed } from "lifi/Errors/GenericErrors.sol";

/// View/error surface of the real Centrifuge TokenBridge that the fork tests need in order to
/// pin its configuration and assert against its own reverts.
/// Mirrors the verified deployment at 0x82a6C7753380f98c093B27c53f86ef6b09C40f49.
interface ICentrifugeTokenBridgeExtended {
    error InvalidChainId();

    function localCentrifugeId() external view returns (uint16);

    function chainIdToCentrifugeId(
        uint256 evmChainId
    ) external view returns (uint16);
}

/// Centrifuge Gateway error raised when the forwarded native value does not cover the
/// cross-chain message.
interface ICentrifugeGatewayErrors {
    error NotEnoughGas();
}

/// @notice Re-enters the facet from `receive()` to prove the `nonReentrant` guard holds.
/// @dev `ReentrancyChecker` from TestBase cannot be reused: its constructor approves the
///      hardcoded Ethereum USDC/DAI addresses, which hold no token contract on Base, so merely
///      deploying it reverts there. This probe is chain-agnostic and approves the asset under
///      test explicitly.
contract CentrifugeReentrancyAttacker {
    address private immutable FACET;
    bytes private _callData;

    error InitialCallFailed(bytes data);
    error ReentrantCallFailed(bytes data);

    constructor(address _facet) {
        FACET = _facet;
    }

    receive() external payable {
        (bool success, bytes memory data) = FACET.call{ value: 1 ether }(
            _callData
        );
        if (!success) {
            if (
                keccak256(data) ==
                keccak256(abi.encodePacked(ReentrancyError.selector))
            ) {
                revert ReentrancyError();
            }

            revert ReentrantCallFailed(data);
        }
    }

    function approveMax(address _token) external {
        ERC20(_token).approve(FACET, type(uint256).max);
    }

    function callFacet(bytes calldata _data) external {
        _callData = _data;
        (bool success, bytes memory data) = FACET.call{ value: 10 ether }(
            _data
        );
        if (!success) {
            // the facet's own native refund failed because our receive() re-entered and was
            // rejected, which is exactly the guard we want to observe
            if (
                keccak256(data) ==
                keccak256(abi.encodePacked(ETHTransferFailed.selector))
            ) {
                revert ReentrancyError();
            }

            revert InitialCallFailed(data);
        }
    }
}

// Stub CentrifugeFacet Contract
contract TestCentrifugeFacet is CentrifugeFacet, TestWhitelistManagerBase {
    constructor(
        ICentrifugeTokenBridge _tokenBridge
    ) CentrifugeFacet(_tokenBridge) {}
}

abstract contract CentrifugeFacetTestBase is TestBaseFacet {
    /// @dev Mirrors the TokenBridge's own event. Declared locally because solc 0.8.17 rejects
    ///      the `Interface.Event` emit syntax (see 101-solidity-contracts).
    event Send(
        address indexed token,
        address indexed sender,
        uint256 destinationChainId,
        bytes32 receiver,
        uint256 amount,
        address refundAddress
    );

    /// @dev The Centrifuge TokenBridge is deployed at the same address on Ethereum and Base.
    ICentrifugeTokenBridge internal constant TOKEN_BRIDGE =
        ICentrifugeTokenBridge(0x82a6C7753380f98c093B27c53f86ef6b09C40f49);

    /// @dev deJAAA, a Centrifuge share token, also deployed at the same address on both chains.
    ///      Its pool hub lives on centrifugeId 1 (Ethereum), so every Ethereum <-> Base transfer
    ///      is a single-leg transfer.
    address internal constant ADDRESS_SHARE_TOKEN =
        0xAAA0008C8CF3A7Dca931adaF04336A5D808C82Cc;

    /// @dev A chain that the bridge has no centrifugeId mapping for, used to prove the
    ///      destination is validated by the bridge itself.
    uint256 internal constant UNSUPPORTED_DESTINATION_CHAIN_ID = 42161;

    /// @dev Generously above the real messaging fee. Centrifuge exposes no on-chain quote, so
    ///      tests assert the fee's effect (bridge consumed some, surplus returned) rather than
    ///      an exact figure that would break whenever the adapters re-price.
    uint256 internal constant DEFAULT_NATIVE_FEE = 0.01 ether;

    ERC20 internal shareToken;
    TestCentrifugeFacet internal centrifugeFacet;
    CentrifugeFacet.CentrifugeData internal validCentrifugeData;
    uint256 internal defaultShareAmount;
    uint256 internal destinationChainId;

    /// @dev Fee split used by the swap-path tests, expressed in share-token units.
    uint256 internal integratorFee;
    uint256 internal lifiFee;

    function setUp() public virtual {
        initTestBase();

        shareToken = ERC20(ADDRESS_SHARE_TOKEN);
        defaultShareAmount = 100 * 10 ** shareToken.decimals();
        integratorFee = 1 * 10 ** shareToken.decimals();
        lifiFee = 2 * 10 ** shareToken.decimals();

        // pinned-block guards: fail loudly here (not deep in a funds-flow assert) if a re-pin
        // lands on a block where Centrifuge has not mapped the destination chain yet
        assertGt(
            ICentrifugeTokenBridgeExtended(address(TOKEN_BRIDGE))
                .chainIdToCentrifugeId(destinationChainId),
            0
        );
        assertEq(
            ICentrifugeTokenBridgeExtended(address(TOKEN_BRIDGE))
                .chainIdToCentrifugeId(UNSUPPORTED_DESTINATION_CHAIN_ID),
            0
        );

        centrifugeFacet = new TestCentrifugeFacet(TOKEN_BRIDGE);
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = centrifugeFacet
            .startBridgeTokensViaCentrifuge
            .selector;
        functionSelectors[1] = centrifugeFacet
            .swapAndStartBridgeTokensViaCentrifuge
            .selector;
        functionSelectors[2] = centrifugeFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = centrifugeFacet
            .removeAllowedContractSelector
            .selector;

        addFacet(diamond, address(centrifugeFacet), functionSelectors);
        centrifugeFacet = TestCentrifugeFacet(address(diamond));

        // the only swap step a Centrifuge share token supports today is same-token fee
        // collection (see setDefaultSwapDataSingleDAItoUSDC below for why)
        centrifugeFacet.addAllowedContractSelector(
            address(feeCollector),
            feeCollector.collectTokenFees.selector
        );

        setFacetAddressInTestBase(address(centrifugeFacet), "CentrifugeFacet");

        // fund the sender with the share token; the bridge only accepts Centrifuge shares
        deal(
            ADDRESS_SHARE_TOKEN,
            USER_SENDER,
            100_000 * 10 ** shareToken.decimals()
        );

        // adjust bridgeData
        bridgeData.bridge = "centrifuge";
        bridgeData.sendingAssetId = ADDRESS_SHARE_TOKEN;
        bridgeData.minAmount = defaultShareAmount;
        bridgeData.destinationChainId = destinationChainId;

        validCentrifugeData = CentrifugeFacet.CentrifugeData({
            nativeFee: DEFAULT_NATIVE_FEE,
            refundRecipient: USER_REFUND
        });
    }

    /// @dev Centrifuge share tokens have no DEX liquidity and their vaults are ERC-7540
    ///      asynchronous, so no swap can produce them atomically. The swap entrypoint therefore
    ///      exists for the other kind of LI.FI swap step: a same-token fee collection, which
    ///      skims the integrator/LI.FI cut off the bridged amount. Overriding the shared helper
    ///      re-points every inherited swap test at that shape instead of DAI -> USDC.
    function setDefaultSwapDataSingleDAItoUSDC() internal virtual override {
        delete swapData;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(feeCollector),
                approveTo: address(feeCollector),
                sendingAssetId: ADDRESS_SHARE_TOKEN,
                receivingAssetId: ADDRESS_SHARE_TOKEN,
                fromAmount: defaultShareAmount + integratorFee + lifiFee,
                callData: abi.encodeWithSelector(
                    feeCollector.collectTokenFees.selector,
                    ADDRESS_SHARE_TOKEN,
                    integratorFee,
                    lifiFee,
                    address(0xb33f)
                ),
                requiresDeposit: true
            })
        );
    }

    function initiateBridgeTxWithFacet(bool isNative) internal override {
        if (isNative) {
            centrifugeFacet.startBridgeTokensViaCentrifuge{
                value: bridgeData.minAmount
            }(bridgeData, validCentrifugeData);
        } else {
            centrifugeFacet.startBridgeTokensViaCentrifuge{
                value: validCentrifugeData.nativeFee
            }(bridgeData, validCentrifugeData);
        }
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        if (isNative) {
            centrifugeFacet.swapAndStartBridgeTokensViaCentrifuge{
                value: swapData[0].fromAmount
            }(bridgeData, swapData, validCentrifugeData);
        } else {
            centrifugeFacet.swapAndStartBridgeTokensViaCentrifuge{
                value: validCentrifugeData.nativeFee
            }(bridgeData, swapData, validCentrifugeData);
        }
    }

    /// Base test overrides ///

    function testBase_CanBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // facet does not support bridging of native assets
    }

    // the bridged asset is a Centrifuge share token, not USDC
    function testBase_CanBridgeTokens() public override {
        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        uint256 senderShareBefore = shareToken.balanceOf(USER_SENDER);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(
            shareToken.balanceOf(USER_SENDER),
            senderShareBefore - defaultShareAmount
        );
        assertEq(shareToken.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
    }

    function testBase_CanBridgeTokens_fuzzed(uint256 amount) public override {
        vm.assume(amount > 0 && amount < 100_000);
        amount = amount * 10 ** shareToken.decimals();

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, amount);

        bridgeData.minAmount = amount;

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(shareToken.balanceOf(address(diamond)), 0);
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        vm.startPrank(USER_SENDER);

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        shareToken.approve(_facetTestContractAddress, swapData[0].fromAmount);

        uint256 senderShareBefore = shareToken.balanceOf(USER_SENDER);

        // the fee-collection step consumes the fees and leaves the remainder as its output,
        // which is what actually gets bridged
        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit AssetSwapped(
            bridgeData.transactionId,
            address(feeCollector),
            ADDRESS_SHARE_TOKEN,
            ADDRESS_SHARE_TOKEN,
            swapData[0].fromAmount,
            defaultShareAmount,
            block.timestamp
        );

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(
            shareToken.balanceOf(USER_SENDER),
            senderShareBefore - swapData[0].fromAmount
        );
        // the fees stay with the FeeCollector, the rest was bridged, nothing is stranded
        assertEq(
            shareToken.balanceOf(address(feeCollector)),
            integratorFee + lifiFee
        );
        assertEq(shareToken.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
    }

    function testBase_Revert_CallerHasInsufficientFunds() public override {
        vm.startPrank(USER_SENDER);

        shareToken.approve(_facetTestContractAddress, defaultShareAmount);

        // move the whole share balance away so the deposit cannot be funded
        shareToken.transfer(USER_RECEIVER, shareToken.balanceOf(USER_SENDER));

        vm.expectRevert(TransferFromFailed.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// Constructor ///

    function test_WillStoreConstructorParametersCorrectly() public {
        centrifugeFacet = new TestCentrifugeFacet(TOKEN_BRIDGE);

        assertEq(
            address(centrifugeFacet.TOKEN_BRIDGE()),
            address(TOKEN_BRIDGE)
        );
    }

    function testRevert_WhenConstructedWithZeroAddress() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestCentrifugeFacet(ICentrifugeTokenBridge(address(0)));
    }

    /// Native asset ///

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

    /// Calldata validation ///

    function testRevert_WhenBridgeWithZeroRefundRecipient() public {
        // without the explicit guard a zero refundRecipient would only revert late in
        // refundExcessNative, and only if there was excess native to refund
        validCentrifugeData.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwapAndBridgeWithZeroRefundRecipient() public {
        validCentrifugeData.refundRecipient = address(0);

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        shareToken.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenBridgeWithZeroNativeFee() public {
        // Centrifuge has no on-chain quote, so a zero fee is always a malformed request
        validCentrifugeData.nativeFee = 0;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwapAndBridgeWithZeroNativeFee() public {
        validCentrifugeData.nativeFee = 0;

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        shareToken.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenNativeFeeExceedsMsgValue() public {
        // on the non-swap path msg.value is the only native source, so the fee must be covered
        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        centrifugeFacet.startBridgeTokensViaCentrifuge{
            value: validCentrifugeData.nativeFee - 1
        }(bridgeData, validCentrifugeData);
        vm.stopPrank();
    }

    function testRevert_WhenNativeFeeIsUnderpaid() public {
        // EXSC-828 open question, answered against the real contracts: an underpaid transfer
        // reverts rather than being queued as an underpaid batch. Centrifuge's
        // `sendInitiateTransferShares` takes no `unpaidMode` flag (unlike `sendRequest`), so the
        // "queued as underpaid" path in the TokenBridge NatSpec only applies to the hub-funded
        // second leg of a spoke -> hub -> spoke transfer. The Ethereum <-> Base corridor is
        // always single-leg for this pool, so a short fee can never strand a transfer here.
        uint256 exactFee = _measureNativeFee();
        validCentrifugeData.nativeFee = exactFee - 1;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(ICentrifugeGatewayErrors.NotEnoughGas.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    /// Bridge behaviour ///

    function test_BridgeSendsSharesToRealTokenBridge() public {
        // EXSC-828 core question: the bridge pulls the share token from msg.sender, which is the
        // Diamond when our facet calls send(). We custody in the Diamond (depositAsset) and
        // approve the bridge, so funds flow USER -> Diamond -> Centrifuge. The receiver is
        // derived from bridgeData, so the on-chain destination always matches the event.
        uint256 senderShareBefore = shareToken.balanceOf(USER_SENDER);
        uint256 senderNativeBefore = USER_SENDER.balance;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(TOKEN_BRIDGE));
        emit Send(
            ADDRESS_SHARE_TOKEN,
            address(diamond),
            destinationChainId,
            LibBytes.toBytes32(USER_RECEIVER),
            defaultShareAmount,
            USER_REFUND
        );

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(
            shareToken.balanceOf(USER_SENDER),
            senderShareBefore - defaultShareAmount
        );
        // the shares left the Diamond entirely and the messaging fee was paid from msg.value
        assertEq(shareToken.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
        assertLt(USER_SENDER.balance, senderNativeBefore);
        // receiver is the end user, never the Diamond
        assertTrue(bridgeData.receiver != address(diamond));
    }

    function test_NativeFeeSurplusIsReturnedToRefundRecipient() public {
        // the bridge forwards the whole nativeFee to the Gateway and names refundRecipient as
        // the refund address, so whatever the adapters do not consume comes back to the user -
        // never to msg.sender, which may be a relayer or the Permit2Proxy
        uint256 refundNativeBefore = USER_REFUND.balance;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        assertGt(USER_REFUND.balance, refundNativeBefore);
        assertEq(address(diamond).balance, 0);
    }

    function test_ExcessNativeAboveFeeIsRefundedToRefundRecipient() public {
        // anything sent above nativeFee never reaches the bridge; refundExcessNative returns it
        uint256 excess = 0.002 ether;

        uint256 refundNativeBefore = USER_REFUND.balance;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        centrifugeFacet.startBridgeTokensViaCentrifuge{
            value: validCentrifugeData.nativeFee + excess
        }(bridgeData, validCentrifugeData);
        vm.stopPrank();

        // the excess plus the Gateway's own surplus refund both land at refundRecipient
        assertGe(USER_REFUND.balance, refundNativeBefore + excess);
        assertEq(address(diamond).balance, 0);
    }

    function testRevert_WhenDestinationChainIsNotSupportedByBridge() public {
        // the bridge keeps its own chainId -> centrifugeId map; an unmapped destination must
        // not silently succeed
        bridgeData.destinationChainId = UNSUPPORTED_DESTINATION_CHAIN_ID;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(
            ICentrifugeTokenBridgeExtended.InvalidChainId.selector
        );

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSendingAssetIsNotACentrifugeShareToken() public {
        // the bridge resolves the share token via spoke.shareTokenDetails, which reverts for
        // anything that is not a registered Centrifuge share
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert();

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function test_SwapAndBridgeCollectsFeesAndBridgesRemainder() public {
        uint256 grossAmount = defaultShareAmount + integratorFee + lifiFee;
        address integratorAddress = address(0xb33f);

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        shareToken.approve(_facetTestContractAddress, grossAmount);

        vm.expectEmit(true, true, true, true, address(TOKEN_BRIDGE));
        emit Send(
            ADDRESS_SHARE_TOKEN,
            address(diamond),
            destinationChainId,
            LibBytes.toBytes32(USER_RECEIVER),
            defaultShareAmount,
            USER_REFUND
        );

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        // fees are credited inside the FeeCollector, the net amount was bridged
        assertEq(
            feeCollector.getTokenBalance(
                integratorAddress,
                ADDRESS_SHARE_TOKEN
            ),
            integratorFee
        );
        assertEq(
            feeCollector.getLifiTokenBalance(ADDRESS_SHARE_TOKEN),
            lifiFee
        );
        assertEq(shareToken.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
    }

    /// @dev Centrifuge exposes no fee quote, so the only way to learn the exact messaging fee at
    ///      the pinned block is to spend it: bridge once with a known overpayment, measure what
    ///      came back to the refund recipient, then roll the fork state back.
    function _measureNativeFee() internal returns (uint256 consumed) {
        uint256 snapshot = vm.snapshotState();
        uint256 refundBefore = USER_REFUND.balance;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        centrifugeFacet.startBridgeTokensViaCentrifuge{
            value: DEFAULT_NATIVE_FEE
        }(bridgeData, validCentrifugeData);
        vm.stopPrank();

        consumed = DEFAULT_NATIVE_FEE - (USER_REFUND.balance - refundBefore);

        vm.revertToState(snapshot);
    }

    /// @dev The excess native has to be routed back to the attacker, since `[CONV:FACET-REFUNDS]`
    ///      sends it to `refundRecipient` rather than to `msg.sender`.
    ///
    ///      The fee is set to exactly what the bridge consumes so that the Centrifuge Gateway has
    ///      no surplus of its own to return. Otherwise the Gateway's refund reaches the attacker
    ///      first and the blocked re-entry surfaces as the Gateway's `CannotRefund()` instead of
    ///      the facet's own `ETHTransferFailed` -> `ReentrancyError`.
    function _deployReentrantAttacker()
        internal
        returns (CentrifugeReentrancyAttacker attacker)
    {
        uint256 exactFee = _measureNativeFee();

        attacker = new CentrifugeReentrancyAttacker(_facetTestContractAddress);
        deal(ADDRESS_SHARE_TOKEN, address(attacker), 10 * defaultShareAmount);
        vm.deal(address(attacker), 10_000 ether);
        attacker.approveMax(ADDRESS_SHARE_TOKEN);

        validCentrifugeData.nativeFee = exactFee;
        validCentrifugeData.refundRecipient = address(attacker);
    }

    function testRevert_WhenReentrantCallBridge() public {
        CentrifugeReentrancyAttacker attacker = _deployReentrantAttacker();

        vm.expectRevert(ReentrancyError.selector);

        attacker.callFacet(
            abi.encodeWithSelector(
                centrifugeFacet.startBridgeTokensViaCentrifuge.selector,
                bridgeData,
                validCentrifugeData
            )
        );
    }

    function testRevert_WhenReentrantCallSwapAndBridge() public {
        CentrifugeReentrancyAttacker attacker = _deployReentrantAttacker();

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();

        vm.expectRevert(ReentrancyError.selector);

        attacker.callFacet(
            abi.encodeWithSelector(
                centrifugeFacet.swapAndStartBridgeTokensViaCentrifuge.selector,
                bridgeData,
                swapData,
                validCentrifugeData
            )
        );
    }
}

contract CentrifugeFacetMainnetTest is CentrifugeFacetTestBase {
    function setUp() public override {
        customBlockNumberForForking = 25900000;
        // Base; the deJAAA pool hub is on Ethereum, so this is a single-leg hub -> spoke transfer
        destinationChainId = 8453;

        super.setUp();
    }

    function test_LocalCentrifugeIdIsEthereum() public view {
        assertEq(
            ICentrifugeTokenBridgeExtended(address(TOKEN_BRIDGE))
                .localCentrifugeId(),
            1
        );
    }
}

contract CentrifugeFacetBaseTest is CentrifugeFacetTestBase {
    function setUp() public override {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 50860000;
        // Ethereum; the deJAAA pool hub is there, so this is a single-leg spoke -> hub transfer
        destinationChainId = 1;

        super.setUp();
    }

    function test_LocalCentrifugeIdIsBase() public view {
        assertEq(
            ICentrifugeTokenBridgeExtended(address(TOKEN_BRIDGE))
                .localCentrifugeId(),
            2
        );
    }
}
