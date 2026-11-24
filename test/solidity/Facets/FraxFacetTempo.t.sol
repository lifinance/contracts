// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { IFraxHopV2 } from "lifi/Interfaces/IFraxHopV2.sol";
import {
    ITempoFeeInclusiveWrapper
} from "lifi/Interfaces/ITempoFeeInclusiveWrapper.sol";
import {
    IWhitelistManagerFacet
} from "lifi/Interfaces/IWhitelistManagerFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { FraxFacet } from "lifi/Facets/FraxFacet.sol";
import { InvalidCallData, InvalidConfig } from "lifi/Errors/GenericErrors.sol";

interface ITip20 {
    function balanceOf(address account) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount)
        external
        returns (bool);
    function mint(address to, uint256 amount) external;
}

interface IStablecoinDex {
    function place(address token, uint128 amount, bool isBid, int16 tick)
        external
        returns (uint128 orderId);

    function swapExactAmountIn(
        address tokenIn,
        address tokenOut,
        uint128 amountIn,
        uint128 minAmountOut
    ) external returns (uint128 amountOut);
}

/// @notice Pass-through to Tempo's StablecoinDEX, standing in for the aggregators LI.FI
///         whitelists on Tempo. The DEX itself cannot be whitelisted: it is a precompile
///         whose code is the single byte 0xef, which LibAllowList rejects (InvalidContract).
///         The swap runs against the real DEX and its real order book.
contract TempoDexRouter {
    address internal constant DEX = 0xDEc0000000000000000000000000000000000000;

    function swap(address _tokenIn, address _tokenOut, uint128 _amountIn)
        external
        returns (uint128 amountOut)
    {
        ITip20(_tokenIn).transferFrom(msg.sender, address(this), _amountIn);
        ITip20(_tokenIn).approve(DEX, _amountIn);
        amountOut = IStablecoinDex(DEX)
            .swapExactAmountIn(_tokenIn, _tokenOut, _amountIn, 0);
        ITip20(_tokenOut).transfer(msg.sender, amountOut);
    }
}

/// @notice Tempo-as-source fork tests for FraxFacet routed through Frax's
///         TempoFeeInclusiveWrapper, run against the forked PRODUCTION Tempo diamond with
///         the prototype facet cut in by its real timelock owner.
/// @dev Needs `forge test --network tempo --match-path test/solidity/Facets/FraxFacetTempo.t.sol`.
///      Without the network flag every TIP20 call reverts (TIP20s are
///      node precompiles), so setUp skips the suite instead of failing the default run,
///      unless FRAX_TEMPO_REQUIRE_FORK=true (the CI tempo shard), where it fails.
///      Does not inherit TestBaseFacet: its base setup deals Ethereum token addresses and
///      deploys a fresh diamond, neither of which exists on Tempo; this suite tests the
///      production diamond itself. TIP20 balances are not storage-backed, so deal() does not
///      work; funding mints frxUSD as the OFT, which holds the TIP20 issuer role.
contract FraxFacetTempoTest is Test {
    /// @notice TIP20 calls revert: the suite ran without `--network tempo`.
    error TempoForkUnavailable();

    address internal constant DIAMOND =
        0x2cAcAE8e22418E65dcf7651c67aEbe6288EB8243;
    address internal constant TIMELOCK =
        0xa7A28FB774a742e82dc237a08d515745f96A46b1;
    address internal constant HOP = 0x0000006D38568b00B457580b734e0076C62de659;
    address internal constant WRAPPER =
        0x2cfcA4A7ecE48860bfb78B7BD7Bd8CC9Ef75DaA3;
    address internal constant OFT = 0x00000000D61733e7A393A10A5B48c311AbE8f1E5;
    address internal constant FRXUSD =
        0x20C0000000000000000000003554d28269E0f3c2;
    address internal constant PATH_USD =
        0x20C0000000000000000000000000000000000000;
    address internal constant DEX = 0xDEc0000000000000000000000000000000000000;
    uint256 internal constant FORK_BLOCK = 50433789;

    uint256 internal constant CHAIN_FRAXTAL = 252;
    uint256 internal constant CHAIN_BASE = 8453;
    uint256 internal constant CHAIN_ARBITRUM = 42161;
    uint256 internal constant CHAIN_SOLANA = 1151111081099710;
    uint32 internal constant EID_FRAXTAL = 30255;
    uint32 internal constant EID_BASE = 30184;
    uint32 internal constant EID_ARBITRUM = 30110;
    uint32 internal constant EID_SOLANA = 30168;
    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;
    bytes32 internal constant SOLANA_RECEIVER = bytes32(uint256(0x5011a9a));

    // frxUSD has 6 decimals on Tempo
    uint256 internal constant AMOUNT = 20_000_000;

    error InsufficientNetAmount(uint256 netAmount, uint256 minNetAmount);

    event LiFiTransferStarted(ILiFi.BridgeData bridgeData);

    FraxFacet internal fraxFacet;
    ITip20 internal frxUsd = ITip20(FRXUSD);
    address internal user;
    address internal refundRecipient;
    address internal receiver;

    function setUp() public {
        // The public endpoint from networks.json, not ETH_NODE_URI_TEMPO: forge forks chain
        // 4217 with Tempo's account policy, which needs eth_getAccountInfo, and the private
        // provider does not serve it (the fork fails with an uncatchable database error).
        string memory networks = vm.readFile(
            string.concat(vm.projectRoot(), "/config/networks.json")
        );
        vm.createSelectFork(
            vm.parseJsonString(networks, ".tempo.rpcUrl"), FORK_BLOCK
        );

        try frxUsd.totalSupply() returns (uint256) { }
        catch {
            // The CI tempo shard sets this, so a broken fork fails there instead of skipping.
            if (vm.envOr("FRAX_TEMPO_REQUIRE_FORK", false)) {
                revert TempoForkUnavailable();
            }
            vm.skip(true);
            return;
        }

        user = makeAddr("user");
        refundRecipient = makeAddr("refundRecipient");
        receiver = makeAddr("receiver");

        FraxFacet newFacet = new FraxFacet(
            IFraxHopV2(HOP), ITempoFeeInclusiveWrapper(WRAPPER)
        );
        _cutIntoProductionDiamond(address(newFacet));
        fraxFacet = FraxFacet(payable(DIAMOND));

        vm.prank(OFT);
        frxUsd.mint(user, 1_000 * 1e6);

        // pinned config the suite depends on
        assertEq(fraxFacet.getFraxChainIdToEid(CHAIN_FRAXTAL), EID_FRAXTAL);
        assertEq(fraxFacet.getFraxChainIdToEid(CHAIN_BASE), EID_BASE);
        assertEq(fraxFacet.getFraxChainIdToEid(CHAIN_ARBITRUM), EID_ARBITRUM);
        assertEq(fraxFacet.getFraxChainIdToEid(CHAIN_SOLANA), EID_SOLANA);
        assertEq(frxUsd.balanceOf(DIAMOND), 0);

        vm.label(DIAMOND, "LiFiDiamond");
        vm.label(WRAPPER, "TempoFeeInclusiveWrapper");
        vm.label(HOP, "FraxHopV2");
        vm.label(FRXUSD, "frxUSD");
        vm.label(PATH_USD, "pathUSD");
        vm.label(DEX, "StablecoinDEX");
    }

    /// @dev The cut a production rollout would make: replace the live FraxFacet 1.0.0
    ///      selectors, drop its two Tempo fee-token getters, add the wrapper getter.
    function _cutIntoProductionDiamond(address _facet) internal {
        bytes4[] memory replaced = new bytes4[](6);
        replaced[0] = FraxFacet.startBridgeTokensViaFrax.selector;
        replaced[1] = FraxFacet.swapAndStartBridgeTokensViaFrax.selector;
        replaced[2] = FraxFacet.setFraxChainIdToEid.selector;
        replaced[3] = FraxFacet.unsetFraxChainIdToEid.selector;
        replaced[4] = FraxFacet.getFraxChainIdToEid.selector;
        replaced[5] = FraxFacet(_facet).FRAX_HOP.selector;

        bytes4[] memory removed = new bytes4[](2);
        removed[0] = bytes4(keccak256("FRAX_TIP_FEE_MANAGER()"));
        removed[1] = bytes4(keccak256("FRAX_PATH_USD()"));

        bytes4[] memory added = new bytes4[](1);
        added[0] = FraxFacet(_facet).FRAX_TEMPO_WRAPPER.selector;

        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](3);
        cut[0] = LibDiamond.FacetCut({
            facetAddress: _facet,
            action: LibDiamond.FacetCutAction.Replace,
            functionSelectors: replaced
        });
        cut[1] = LibDiamond.FacetCut({
            facetAddress: address(0),
            action: LibDiamond.FacetCutAction.Remove,
            functionSelectors: removed
        });
        cut[2] = LibDiamond.FacetCut({
            facetAddress: _facet,
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: added
        });

        vm.prank(TIMELOCK);
        IDiamondCut(DIAMOND).diamondCut(cut, address(0), "");
    }

    function _bridgeData(uint256 _destinationChainId, address _receiver)
        internal
        pure
        returns (ILiFi.BridgeData memory)
    {
        return ILiFi.BridgeData({
            transactionId: "tempoSource",
            bridge: "frax",
            integrator: "",
            referrer: address(0),
            sendingAssetId: FRXUSD,
            receiver: _receiver,
            minAmount: AMOUNT,
            destinationChainId: _destinationChainId,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
    }

    function _recipientOf(address _receiver, bytes32 _nonEVMReceiver)
        internal
        pure
        returns (bytes32)
    {
        return _receiver == NON_EVM_ADDRESS
            ? _nonEVMReceiver
            : bytes32(uint256(uint160(_receiver)));
    }

    function _quote(uint32 _dstEid, bytes32 _recipient, uint256 _amount)
        internal
        view
        returns (uint256 fee, uint256 net)
    {
        (, fee, net) = ITempoFeeInclusiveWrapper(WRAPPER)
            .quoteFeeInclusive(OFT, _dstEid, _recipient, _amount, 0, "");
    }

    /// @dev nativeFee as BE would set it: the live fee plus Frax's 10% API buffer
    function _fraxData(
        uint32 _dstEid,
        bytes32 _recipient,
        uint256 _amount,
        bytes32 _nonEVMReceiver
    ) internal view returns (FraxFacet.FraxData memory) {
        (uint256 fee,) = _quote(_dstEid, _recipient, _amount);
        return FraxFacet.FraxData({
            oft: OFT,
            dstEid: _dstEid,
            nativeFee: fee + fee / 10,
            refundRecipient: refundRecipient,
            nonEVMReceiver: _nonEVMReceiver
        });
    }

    /// @dev Bridges AMOUNT and checks the money flow: the user pays exactly AMOUNT with
    ///      one approval and no native, the diamond keeps nothing, the event reports the
    ///      net the OFT burned, and the residual reaches refundRecipient.
    function _bridgeAndAssert(
        uint256 _destinationChainId,
        uint32 _dstEid,
        address _receiver,
        bytes32 _nonEVMReceiver,
        string memory _label
    ) internal {
        ILiFi.BridgeData memory bridgeData = _bridgeData(
            _destinationChainId, _receiver
        );
        bytes32 recipient = _recipientOf(_receiver, _nonEVMReceiver);
        FraxFacet.FraxData memory fraxData =
            _fraxData(_dstEid, recipient, AMOUNT, _nonEVMReceiver);
        (, uint256 expectedNet) = _quote(_dstEid, recipient, AMOUNT);

        uint256 userBefore = frxUsd.balanceOf(user);
        uint256 supplyBefore = frxUsd.totalSupply();
        uint256 refundBefore = frxUsd.balanceOf(refundRecipient);

        ILiFi.BridgeData memory expected =
            _bridgeData(_destinationChainId, _receiver);
        expected.minAmount = expectedNet;

        vm.startPrank(user);

        frxUsd.approve(DIAMOND, AMOUNT);

        vm.expectEmit(true, true, true, true, DIAMOND);
        emit LiFiTransferStarted(expected);

        uint256 gasBefore = gasleft();
        fraxFacet.startBridgeTokensViaFrax(bridgeData, fraxData);
        emit log_named_uint(_label, gasBefore - gasleft());

        vm.stopPrank();

        assertEq(userBefore - frxUsd.balanceOf(user), AMOUNT);
        assertEq(frxUsd.balanceOf(DIAMOND), 0);
        assertEq(frxUsd.balanceOf(WRAPPER), 0);
        assertEq(supplyBefore - frxUsd.totalSupply(), expectedNet);
        assertGe(expectedNet, AMOUNT - fraxData.nativeFee);
        assertLe(
            frxUsd.balanceOf(refundRecipient) - refundBefore,
            AMOUNT - expectedNet
        );
    }

    function test_BridgesFrxUsdToFraxtalWithOneApproval() public {
        _bridgeAndAssert(
            CHAIN_FRAXTAL, EID_FRAXTAL, receiver, bytes32(0), "gas fraxtal"
        );
    }

    function test_BridgesFrxUsdToBaseViaHub() public {
        _bridgeAndAssert(
            CHAIN_BASE, EID_BASE, receiver, bytes32(0), "gas base"
        );
    }

    function test_BridgesFrxUsdToArbitrumViaHub() public {
        _bridgeAndAssert(
            CHAIN_ARBITRUM, EID_ARBITRUM, receiver, bytes32(0), "gas arbitrum"
        );
    }

    function test_BridgesFrxUsdToSolanaWithBytes32Receiver() public {
        _bridgeAndAssert(
            CHAIN_SOLANA,
            EID_SOLANA,
            NON_EVM_ADDRESS,
            SOLANA_RECEIVER,
            "gas solana"
        );
    }

    function test_LeavesPreExistingDiamondBalanceUntouched() public {
        vm.prank(OFT);
        frxUsd.mint(DIAMOND, 3_000_000);

        ILiFi.BridgeData memory bridgeData =
            _bridgeData(CHAIN_FRAXTAL, receiver);
        FraxFacet.FraxData memory fraxData = _fraxData(
            EID_FRAXTAL, _recipientOf(receiver, bytes32(0)), AMOUNT, bytes32(0)
        );
        uint256 refundBefore = frxUsd.balanceOf(refundRecipient);

        vm.startPrank(user);

        frxUsd.approve(DIAMOND, AMOUNT);
        fraxFacet.startBridgeTokensViaFrax(bridgeData, fraxData);

        vm.stopPrank();

        assertEq(frxUsd.balanceOf(DIAMOND), 3_000_000);
        assertLt(frxUsd.balanceOf(refundRecipient) - refundBefore, 3_000_000);
    }

    function test_SwapsPathUsdToFrxUsdAndBridges() public {
        address maker = makeAddr("maker");
        vm.prank(OFT);
        frxUsd.mint(maker, 100 * 1e6);
        vm.startPrank(maker);
        frxUsd.approve(DEX, type(uint256).max);
        IStablecoinDex(DEX).place(FRXUSD, uint128(100 * 1e6), false, 0);
        vm.stopPrank();

        // user acquires pathUSD on the real DEX (frxUSD -> pathUSD has live liquidity)
        vm.startPrank(user);
        frxUsd.approve(DEX, 50 * 1e6);
        uint128 pathUsdAmount = IStablecoinDex(DEX)
            .swapExactAmountIn(FRXUSD, PATH_USD, uint128(50 * 1e6), 0);
        vm.stopPrank();

        TempoDexRouter router = new TempoDexRouter();
        bytes4 swapSelector = TempoDexRouter.swap.selector;
        vm.prank(TIMELOCK);
        IWhitelistManagerFacet(DIAMOND)
            .setContractSelectorWhitelist(address(router), swapSelector, true);

        LibSwap.SwapData[] memory swapData = new LibSwap.SwapData[](1);
        swapData[0] = LibSwap.SwapData({
            callTo: address(router),
            approveTo: address(router),
            sendingAssetId: PATH_USD,
            receivingAssetId: FRXUSD,
            fromAmount: pathUsdAmount,
            callData: abi.encodeWithSelector(
                swapSelector, PATH_USD, FRXUSD, pathUsdAmount
            ),
            requiresDeposit: true
        });

        ILiFi.BridgeData memory bridgeData =
            _bridgeData(CHAIN_FRAXTAL, receiver);
        bridgeData.hasSourceSwaps = true;
        // minAmount is the swap floor; the swap's real output becomes the bridged gross
        bridgeData.minAmount = pathUsdAmount - 1_000_000;
        FraxFacet.FraxData memory fraxData = _fraxData(
            EID_FRAXTAL,
            _recipientOf(receiver, bytes32(0)),
            bridgeData.minAmount,
            bytes32(0)
        );
        uint256 supplyBefore = frxUsd.totalSupply();

        vm.startPrank(user);

        ITip20(PATH_USD).approve(DIAMOND, pathUsdAmount);

        uint256 gasBefore = gasleft();
        fraxFacet.swapAndStartBridgeTokensViaFrax(
            bridgeData, swapData, fraxData
        );
        emit log_named_uint("gas swap+fraxtal", gasBefore - gasleft());

        vm.stopPrank();

        assertEq(frxUsd.balanceOf(DIAMOND), 0);
        assertEq(ITip20(PATH_USD).balanceOf(DIAMOND), 0);
        assertGe(
            supplyBefore - frxUsd.totalSupply(),
            pathUsdAmount - fraxData.nativeFee
        );
    }

    function testRevert_WhenNativeFeeBelowLiveFee() public {
        ILiFi.BridgeData memory bridgeData =
            _bridgeData(CHAIN_FRAXTAL, receiver);
        bytes32 recipient = _recipientOf(receiver, bytes32(0));
        FraxFacet.FraxData memory fraxData =
            _fraxData(EID_FRAXTAL, recipient, AMOUNT, bytes32(0));
        (uint256 fee, uint256 net) = _quote(EID_FRAXTAL, recipient, AMOUNT);
        fraxData.nativeFee = fee - 1;

        vm.startPrank(user);

        frxUsd.approve(DIAMOND, AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(
                InsufficientNetAmount.selector,
                net,
                AMOUNT - fraxData.nativeFee
            )
        );

        fraxFacet.startBridgeTokensViaFrax(bridgeData, fraxData);

        vm.stopPrank();
    }

    function testRevert_WhenNativeFeeZero() public {
        ILiFi.BridgeData memory bridgeData =
            _bridgeData(CHAIN_FRAXTAL, receiver);
        bytes32 recipient = _recipientOf(receiver, bytes32(0));
        FraxFacet.FraxData memory fraxData =
            _fraxData(EID_FRAXTAL, recipient, AMOUNT, bytes32(0));
        (, uint256 net) = _quote(EID_FRAXTAL, recipient, AMOUNT);
        fraxData.nativeFee = 0;

        vm.startPrank(user);

        frxUsd.approve(DIAMOND, AMOUNT);

        vm.expectRevert(
            abi.encodeWithSelector(InsufficientNetAmount.selector, net, AMOUNT)
        );

        fraxFacet.startBridgeTokensViaFrax(bridgeData, fraxData);

        vm.stopPrank();
    }

    function testRevert_WhenNativeFeeCoversWholeAmount() public {
        ILiFi.BridgeData memory bridgeData =
            _bridgeData(CHAIN_FRAXTAL, receiver);
        FraxFacet.FraxData memory fraxData = _fraxData(
            EID_FRAXTAL, _recipientOf(receiver, bytes32(0)), AMOUNT, bytes32(0)
        );
        fraxData.nativeFee = AMOUNT;

        vm.startPrank(user);

        frxUsd.approve(DIAMOND, AMOUNT);

        vm.expectRevert(InvalidCallData.selector);

        fraxFacet.startBridgeTokensViaFrax(bridgeData, fraxData);

        vm.stopPrank();
    }

    /// @dev Tempo has no native token and rejects value transfers before the diamond runs,
    ///      so the facet's msg.value guard is unreachable here; this pins the chain's revert.
    function testRevert_WhenNativeValueSent() public {
        ILiFi.BridgeData memory bridgeData =
            _bridgeData(CHAIN_FRAXTAL, receiver);
        FraxFacet.FraxData memory fraxData = _fraxData(
            EID_FRAXTAL, _recipientOf(receiver, bytes32(0)), AMOUNT, bytes32(0)
        );
        vm.deal(user, 1 ether);

        vm.startPrank(user);

        frxUsd.approve(DIAMOND, AMOUNT);

        vm.expectRevert(bytes(""));

        fraxFacet.startBridgeTokensViaFrax{ value: 1 }(bridgeData, fraxData);

        vm.stopPrank();
    }

    function test_StoresConstructorParameters() public {
        FraxFacet facet = new FraxFacet(
            IFraxHopV2(HOP), ITempoFeeInclusiveWrapper(WRAPPER)
        );

        assertEq(address(facet.FRAX_HOP()), HOP);
        assertEq(address(facet.FRAX_TEMPO_WRAPPER()), WRAPPER);
    }

    function testRevert_WhenWrapperForwardsToAnotherHop() public {
        vm.expectRevert(InvalidConfig.selector);

        new FraxFacet(
            IFraxHopV2(makeAddr("otherHop")),
            ITempoFeeInclusiveWrapper(WRAPPER)
        );
    }
}
