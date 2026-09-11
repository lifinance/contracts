// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Vm } from "forge-std/Vm.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { CentrifugeFacet } from "lifi/Facets/CentrifugeFacet.sol";
import { ICentrifugeTokenBridge } from "lifi/Interfaces/ICentrifugeTokenBridge.sol";
import { InformationMismatch, InvalidCallData, InvalidConfig, InvalidReceiver, NativeAssetNotSupported, ReentrancyError, TransferFromFailed } from "lifi/Errors/GenericErrors.sol";

/// View/error surface of the real Centrifuge TokenBridge that the fork tests need in order to
/// pin its configuration and assert against its own reverts.
/// Mirrors the verified deployment at 0x82a6C7753380f98c093B27c53f86ef6b09C40f49.
interface ICentrifugeTokenBridgeExtended {
    error InvalidChainId();
    /// @dev Declared by ITokenBridge, but actually raised by the Spoke's shareTokenDetails
    ///      when the token is not a registered Centrifuge share.
    error ShareTokenDoesNotExist();

    function localCentrifugeId() external view returns (uint16);

    function chainIdToCentrifugeId(
        uint256 evmChainId
    ) external view returns (uint16);

    function spoke() external view returns (address);
}

/// Registry the TokenBridge resolves the asset through; used to pin the share token's
/// registration at the forked block.
interface ICentrifugeSpoke {
    function shareTokenDetails(
        address shareToken
    ) external view returns (uint64 poolId, bytes16 scId);
}

/// Centrifuge Gateway error raised when the forwarded native value does not cover the
/// cross-chain message.
interface ICentrifugeGatewayErrors {
    error NotEnoughGas();
}

/// Aerodrome Slipstream's router on Base, the concentrated-liquidity venue where deJAAA trades
/// against USDC. Its parameter struct carries `tickSpacing` where Uniswap V3 carries `fee`.
interface ISlipstreamSwapRouter {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    function exactOutputSingle(
        ExactOutputSingleParams calldata params
    ) external payable returns (uint256 amountIn);
}

/// @notice Re-enters the facet from `receive()` to prove the `nonReentrant` guard holds.
/// @dev `ReentrancyChecker` from TestBase cannot be reused: its constructor approves the
///      hardcoded Ethereum USDC/DAI addresses, which hold no token contract on Base, so merely
///      deploying it reverts there. This probe is chain-agnostic and approves the asset under
///      test explicitly.
///
///      `receive()` records the re-entrant call's outcome and returns instead of reverting, so
///      the test can assert on that outcome directly. Reverting here would surface as the
///      facet's own `ETHTransferFailed` - Solady's ETH transfer erases the inner revert data,
///      so that error is raised for ANY inner failure and asserting on it proves nothing about
///      the guard. Returning normally keeps the recorded selector, since a reverted `receive()`
///      would roll its own storage write back.
contract CentrifugeReentrancyAttacker {
    /// @notice Revert data of the re-entrant call, empty when it went through.
    bytes public innerRevertData;
    /// @notice True when the re-entrant call succeeded, i.e. the guard did not hold.
    bool public innerCallSucceeded;

    address private immutable FACET;
    bytes private _callData;
    bool private _reentryAttempted;

    error InitialCallFailed(bytes data);

    constructor(address _facet) {
        FACET = _facet;
    }

    receive() external payable {
        // only the first refund re-enters: without the guard the re-entrant bridge succeeds and
        // refunds in turn, which would otherwise recurse until the attacker runs out of shares
        if (_reentryAttempted) return;
        _reentryAttempted = true;

        (bool success, bytes memory data) = FACET.call{ value: 1 ether }(
            _callData
        );

        innerCallSucceeded = success;
        innerRevertData = data;
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

    /// @dev The share token under test, defaulting to deJAAA. Both deRWA tokens are deployed at
    ///      the same address on Ethereum and Base, and both pool hubs live on centrifugeId 1
    ///      (Ethereum), so every Ethereum <-> Base transfer is a single-leg transfer. A concrete
    ///      suite overrides this before calling `super.setUp()` to run the whole battery against
    ///      a different asset.
    // matches how TestBase names its own re-pointable token addresses (ADDRESS_USDC et al)
    // solhint-disable-next-line var-name-mixedcase
    address internal ADDRESS_SHARE_TOKEN =
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

        // the bridge resolves the asset through the Spoke, so a re-pin onto a block predating
        // this token's registration must fail here rather than as a bare ShareTokenDoesNotExist
        // deep inside a funds-flow assert
        (uint64 poolId, ) = ICentrifugeSpoke(
            ICentrifugeTokenBridgeExtended(address(TOKEN_BRIDGE)).spoke()
        ).shareTokenDetails(ADDRESS_SHARE_TOKEN);
        assertGt(uint256(poolId), 0);

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

        // the swap step the shared battery uses (see setDefaultSwapDataSingleDAItoUSDC below)
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

    /// @dev The inherited DAI -> USDC shape cannot be used here: the last swap has to output a
    ///      registered Centrifuge share, or the facet rejects it with `InformationMismatch`.
    ///      Same-token fee collection - skimming the integrator/LI.FI cut off the bridged amount
    ///      - is the one swap step that holds for every suite in this battery, including deJTRSY
    ///      and the Ethereum leg, for which no DEX pool was found. It is therefore what the
    ///      shared override uses. Real cross-token coverage is the Base suite's job: deJAAA does
    ///      trade against USDC there, and `CentrifugeFacetBaseSwapTest` bridges the output of
    ///      that swap.
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

    function testRevert_WhenBridgeReceiverIsTheNonEvmSentinel() public {
        // the sentinel is forwarded verbatim to the bridge, so shares would be minted to
        // 0x11f1...f1 itself on the destination chain and nobody could move them
        bridgeData.receiver = NON_EVM_ADDRESS;

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenSwapAndBridgeReceiverIsTheNonEvmSentinel() public {
        bridgeData.receiver = NON_EVM_ADDRESS;

        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        shareToken.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InvalidReceiver.selector);

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();
    }

    function testRevert_WhenFinalSwapDoesNotOutputTheBridgedAsset() public {
        // _depositAndSwap measures the received amount in the last swap's receivingAssetId while
        // the bridge call acts on sendingAssetId; without the guard the swap output is stranded
        // in the diamond and whatever share-token residue it holds gets bridged instead
        vm.startPrank(USER_SENDER);
        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();
        swapData[0].receivingAssetId = ADDRESS_USDC;
        shareToken.approve(_facetTestContractAddress, swapData[0].fromAmount);

        vm.expectRevert(InformationMismatch.selector);

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
            bytes32(bytes20(USER_RECEIVER)),
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

    function test_ReceiverIsEncodedTheWayTheDestinationDecodesIt() public {
        // Nothing on the source chain validates the receiver encoding: the TokenBridge forwards
        // the bytes32 verbatim and only Centrifuge's spoke decodes it, with CastLib.toAddress -
        // high 20 bytes, and a PrefixNotZero() revert unless the low 12 are clear. A left-padded
        // receiver therefore bridges "successfully" and then strands the shares on arrival, so
        // assert the destination's rule here rather than just that a send happened.
        vm.recordLogs();

        vm.startPrank(USER_SENDER);
        shareToken.approve(_facetTestContractAddress, bridgeData.minAmount);

        initiateBridgeTxWithFacet(false);
        vm.stopPrank();

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sendTopic = keccak256(
            "Send(address,address,uint256,bytes32,uint256,address)"
        );

        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter != address(TOKEN_BRIDGE) ||
                logs[i].topics[0] != sendTopic
            ) continue;

            (, bytes32 receiver, , ) = abi.decode(
                logs[i].data,
                (uint256, bytes32, uint256, address)
            );

            assertEq(
                uint96(uint256(receiver)),
                0,
                "low 12 bytes must be zero"
            );
            assertEq(address(bytes20(receiver)), USER_RECEIVER);
            found = true;
        }

        assertTrue(found, "no Send event emitted by the TokenBridge");
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

        vm.expectRevert(
            ICentrifugeTokenBridgeExtended.ShareTokenDoesNotExist.selector
        );

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
            bytes32(bytes20(USER_RECEIVER)),
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
    ///      no surplus of its own to return, which keeps the single re-entry the attacker records
    ///      the one triggered by the facet's own `refundExcessNative`.
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

    /// @dev Asserts the re-entrant call was rejected by the guard specifically, rather than by
    ///      any of the other reasons an inner call can fail.
    function _assertReentrancyWasBlocked(
        CentrifugeReentrancyAttacker _attacker
    ) internal view {
        assertFalse(
            _attacker.innerCallSucceeded(),
            "the re-entrant call went through"
        );
        assertEq(
            _attacker.innerRevertData(),
            abi.encodePacked(ReentrancyError.selector),
            "the re-entrant call failed for a reason other than the guard"
        );
    }

    function test_ReentrantBridgeCallIsBlocked() public {
        CentrifugeReentrancyAttacker attacker = _deployReentrantAttacker();

        attacker.callFacet(
            abi.encodeWithSelector(
                centrifugeFacet.startBridgeTokensViaCentrifuge.selector,
                bridgeData,
                validCentrifugeData
            )
        );

        _assertReentrancyWasBlocked(attacker);
    }

    function test_ReentrantSwapAndBridgeCallIsBlocked() public {
        CentrifugeReentrancyAttacker attacker = _deployReentrantAttacker();

        bridgeData.hasSourceSwaps = true;
        setDefaultSwapDataSingleDAItoUSDC();

        attacker.callFacet(
            abi.encodeWithSelector(
                centrifugeFacet.swapAndStartBridgeTokensViaCentrifuge.selector,
                bridgeData,
                swapData,
                validCentrifugeData
            )
        );

        _assertReentrancyWasBlocked(attacker);
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

/// @dev deJTRSY is the second deRWA share token registered on both Ethereum and Base with a
///      permissive (freeze-only) hook, so it is bridgeable through this facet today. Re-running
///      the whole battery against it proves the facet is not accidentally specific to deJAAA.
address constant ADDRESS_DEJTRSY = 0xA6233014B9b7aaa74f38fa1977ffC7A89642dC72;

contract CentrifugeFacetMainnetDeJtrsyTest is CentrifugeFacetTestBase {
    function setUp() public override {
        customBlockNumberForForking = 25900000;
        destinationChainId = 8453;
        ADDRESS_SHARE_TOKEN = ADDRESS_DEJTRSY;

        super.setUp();
    }
}

contract CentrifugeFacetBaseDeJtrsyTest is CentrifugeFacetTestBase {
    function setUp() public override {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 50860000;
        destinationChainId = 1;
        ADDRESS_SHARE_TOKEN = ADDRESS_DEJTRSY;

        super.setUp();
    }
}

/// @dev Covers the cross-token route the /quote endpoint advertises - buy the share token, then
///      bridge it - against the real DEX. deJAAA is the one share token in this battery with a
///      live market: an Aerodrome Slipstream USDC pool on Base.
contract CentrifugeFacetBaseSwapTest is CentrifugeFacetTestBase {
    ISlipstreamSwapRouter internal constant SLIPSTREAM_ROUTER =
        ISlipstreamSwapRouter(0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5);

    /// @dev Slipstream keys its pools by tick spacing rather than by fee. USDC/deJAAA exists at
    ///      both 1 and 100; only this one carries liquidity at the pinned block.
    int24 internal constant POOL_TICK_SPACING = 1;

    /// @dev Comfortably above the ~104.1 USDC the pool charges for 100 deJAAA at the pinned
    ///      block. `exactOutputSingle` pulls only what the swap needs, so the remainder is swept
    ///      back to the leftover receiver - which the assertions below check.
    uint256 internal constant MAX_USDC_IN = 130 * 10 ** 6;

    function setUp() public override {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 50860000;
        destinationChainId = 1;

        super.setUp();

        centrifugeFacet.addAllowedContractSelector(
            address(SLIPSTREAM_ROUTER),
            ISlipstreamSwapRouter.exactOutputSingle.selector
        );

        deal(ADDRESS_USDC, USER_SENDER, MAX_USDC_IN);
    }

    function test_CanBuySharesWithUsdcAndBridgeThem() public {
        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(SLIPSTREAM_ROUTER),
                approveTo: address(SLIPSTREAM_ROUTER),
                sendingAssetId: ADDRESS_USDC,
                receivingAssetId: ADDRESS_SHARE_TOKEN,
                fromAmount: MAX_USDC_IN,
                callData: abi.encodeWithSelector(
                    ISlipstreamSwapRouter.exactOutputSingle.selector,
                    ISlipstreamSwapRouter.ExactOutputSingleParams({
                        tokenIn: ADDRESS_USDC,
                        tokenOut: ADDRESS_SHARE_TOKEN,
                        tickSpacing: POOL_TICK_SPACING,
                        recipient: _facetTestContractAddress,
                        deadline: block.timestamp,
                        amountOut: defaultShareAmount,
                        amountInMaximum: MAX_USDC_IN,
                        sqrtPriceLimitX96: 0
                    })
                ),
                requiresDeposit: true
            })
        );

        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = defaultShareAmount;

        uint256 refundUsdcBefore = usdc.balanceOf(USER_REFUND);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, MAX_USDC_IN);

        vm.expectEmit(true, true, true, true, address(TOKEN_BRIDGE));
        emit Send(
            ADDRESS_SHARE_TOKEN,
            address(diamond),
            destinationChainId,
            bytes32(bytes20(USER_RECEIVER)),
            defaultShareAmount,
            USER_REFUND
        );

        initiateSwapAndBridgeTxWithFacet(false);
        vm.stopPrank();

        assertEq(usdc.balanceOf(USER_SENDER), 0);
        // the USDC the swap did not need comes back to the leftover receiver, never to msg.sender
        assertGt(usdc.balanceOf(USER_REFUND), refundUsdcBefore);
        assertEq(usdc.balanceOf(address(diamond)), 0);
        assertEq(shareToken.balanceOf(address(diamond)), 0);
        assertEq(address(diamond).balance, 0);
    }
}
