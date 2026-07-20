// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibSwap } from "../utils/TestBase.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";
import { ISupersetHubPoolManager } from "lifi/Interfaces/ISupersetHubPoolManager.sol";
import { ISupersetSpokePoolManager } from "lifi/Interfaces/ISupersetSpokePoolManager.sol";
import { ISupersetPoolManager } from "lifi/Interfaces/ISupersetPoolManager.sol";
import { IOmniTokenAddressBook } from "lifi/Interfaces/IOmniTokenAddressBook.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";
import { DeadlineExpired, InvalidConfig, NativeAssetNotSupported, InformationMismatch, NotInitialized, OnlyContractOwner, UnsupportedChainId } from "lifi/Errors/GenericErrors.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

/// @dev Resolves OmniToken IDs to local tokens. Defaults to interpreting the ID
///      as a raw EVM address (mirrors the mocks' test-only path shortcut); an
///      explicit mapping can be set via `setToken`.
contract MockOmniTokenAddressBook is IOmniTokenAddressBook {
    mapping(uint256 => address) private tokens;

    function setToken(uint256 _id, address _token) external {
        tokens[_id] = _token;
    }

    function getAddressForOmniToken(
        uint256 _id
    ) external view override returns (address) {
        address token = tokens[_id];

        return token == address(0) ? address(uint160(_id)) : token;
    }
}

/// @dev Hub-side mock — 7-arg ABI matching Superset's `HubPoolManager`.
contract MockSupersetHubPoolManager is
    ISupersetHubPoolManager,
    ISupersetPoolManager
{
    using SafeERC20 for IERC20;

    IOmniTokenAddressBook public immutable ADDRESS_BOOK;

    constructor() {
        ADDRESS_BOOK = new MockOmniTokenAddressBook();
    }

    function getOmniTokenAddressBook()
        external
        view
        override
        returns (IOmniTokenAddressBook)
    {
        return ADDRESS_BOOK;
    }

    struct Call {
        bytes path;
        uint256 amountIn;
        uint256 amountOutMin;
        address recipient;
        address fallbackEoA;
        uint256 deadline;
        uint32 toEid;
        uint256 lzFee;
        address inputToken;
    }

    Call public lastCall;

    function multiHopSwapWithOutputChain(
        bytes calldata _path,
        uint256 _amountIn,
        uint256 _amountOutMin,
        address _recipient,
        address _fallbackEoA,
        uint256 _deadline,
        uint32 _toEid
    ) external payable override {
        // Test-only shortcut: the hub test embeds a raw EVM address in the
        // first 32 bytes of `_path`. The real Superset hub encodes an
        // omniTokenId there and resolves it via its OmniTokenAddressBook.
        address inputToken = address(uint160(uint256(bytes32(_path[0:32]))));

        IERC20(inputToken).safeTransferFrom(
            msg.sender,
            address(this),
            _amountIn
        );

        lastCall = Call({
            path: _path,
            amountIn: _amountIn,
            amountOutMin: _amountOutMin,
            recipient: _recipient,
            fallbackEoA: _fallbackEoA,
            deadline: _deadline,
            toEid: _toEid,
            lzFee: msg.value,
            inputToken: inputToken
        });
    }
}

/// @dev Test-only router that performs a fixed-rate swap so the
///      `amountOutMin = minAmount * percent / 1e18` math is exact.
contract MockFixedSwapRouter {
    using SafeERC20 for IERC20;

    function swap(
        address _fromToken,
        address _toToken,
        uint256 _fromAmount,
        uint256 _toAmount,
        address _to
    ) external {
        IERC20(_fromToken).safeTransferFrom(
            msg.sender,
            address(this),
            _fromAmount
        );
        IERC20(_toToken).safeTransfer(_to, _toAmount);
    }
}

contract TestSupersetFacet is SupersetFacet, TestWhitelistManagerBase {
    constructor(address _poolManager) SupersetFacet(_poolManager) {}
}

contract SupersetFacetTest is TestBaseFacet {
    event SupersetChainMappingsInitialized(
        SupersetFacet.ChainIdConfig[] chainIdConfigs
    );
    event ChainIdToEidSet(uint256 indexed chainId, uint32 lzEid);

    // Real Superset spoke deployment on Base mainnet (see config/superset.json).
    address internal constant SPOKE_POOL_MANAGER =
        0x57C155a15a9CA0A6C1F759ac6988b4fCa3663Ea4;
    // Destination LayerZero EID for Unichain (used end-to-end by demoSuperset).
    uint32 internal constant TO_EID = 30320;
    // Generous native budget; spoke quotes a smaller amount from EndpointV2.quote()
    // and refunds the excess via `refundRecipient`.
    uint256 internal constant LZ_FEE = 0.005 ether;

    TestSupersetFacet internal supersetFacet;
    SupersetFacet.SupersetData internal validSupersetData;

    function _defaultChainIdConfigs()
        internal
        pure
        returns (SupersetFacet.ChainIdConfig[] memory configs)
    {
        configs = new SupersetFacet.ChainIdConfig[](3);
        configs[0] = SupersetFacet.ChainIdConfig({
            chainId: 42161,
            lzEid: 30110
        }); // Arbitrum
        configs[1] = SupersetFacet.ChainIdConfig({
            chainId: 8453,
            lzEid: 30184
        }); // Base
        configs[2] = SupersetFacet.ChainIdConfig({
            chainId: 130,
            lzEid: 30320
        }); // Unichain
    }

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 46595000;
        initTestBase();

        supersetFacet = new TestSupersetFacet(SPOKE_POOL_MANAGER);

        bytes4[] memory functionSelectors = new bytes4[](6);
        functionSelectors[0] = supersetFacet
            .startBridgeTokensViaSuperset
            .selector;
        functionSelectors[1] = supersetFacet
            .swapAndStartBridgeTokensViaSuperset
            .selector;
        functionSelectors[2] = supersetFacet
            .addAllowedContractSelector
            .selector;
        functionSelectors[3] = supersetFacet.initSuperset.selector;
        functionSelectors[4] = supersetFacet.setChainIdToEid.selector;
        functionSelectors[5] = supersetFacet.getChainIdToEid.selector;

        addFacet(diamond, address(supersetFacet), functionSelectors);
        supersetFacet = TestSupersetFacet(payable(address(diamond)));

        vm.startPrank(USER_DIAMOND_OWNER);
        supersetFacet.initSuperset(_defaultChainIdConfigs());
        vm.stopPrank();

        supersetFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapExactTokensForTokens.selector
        );
        supersetFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapTokensForExactETH.selector
        );
        supersetFacet.addAllowedContractSelector(
            ADDRESS_UNISWAP,
            uniswap.swapETHForExactTokens.selector
        );

        setFacetAddressInTestBase(address(supersetFacet), "SupersetFacet");

        bridgeData.bridge = "superset";
        bridgeData.destinationChainId = 130; // Unichain
        addToMessageValue = LZ_FEE;

        validSupersetData = SupersetFacet.SupersetData({
            // omniId=2 (USDC) → fee=3000 → omniId=3 (WBTC). Identical encoding
            // to the executed mainnet run in demoSuperset.ts.
            path: abi.encodePacked(
                bytes32(uint256(2)),
                bytes3(uint24(3000)),
                bytes32(uint256(3))
            ),
            amountOutMin: 1,
            refundRecipient: USER_SENDER,
            // Pure EOA (no code on Base); spoke's SwapDelivery enforces this.
            fallbackEoA: 0x34E7db45783b50F4e7764258d0Dc0400c3539A57,
            deadline: block.timestamp + 1 hours,
            toEid: TO_EID,
            // Real LayerZero executor options (lzReceive gas limit + value)
            // copied from the executed demoSuperset Base→Unichain run.
            options: hex"000301002101000000000000000000000000000000000000000000000000000025241fc03498",
            lzFee: LZ_FEE
        });
    }

    function initiateBridgeTxWithFacet(bool) internal override {
        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function initiateSwapAndBridgeTxWithFacet(
        bool isNative
    ) internal override {
        uint256 value = isNative
            ? swapData[0].fromAmount + validSupersetData.lzFee
            : validSupersetData.lzFee;

        supersetFacet.swapAndStartBridgeTokensViaSuperset{ value: value }(
            bridgeData,
            swapData,
            validSupersetData
        );
    }

    // --- Native source asset is intentionally unsupported (see facet NatSpec) ---

    function testBase_CanBridgeNativeTokens() public override {
        // Facet rejects native source asset; covered by `testRevert_NativeAssetNotSupported_Bridge`.
    }

    function testBase_CanSwapAndBridgeNativeTokens() public override {
        // Facet rejects native source asset; covered by `testRevert_NativeAssetNotSupported_SwapAndBridge`.
    }

    function testBase_CanSwapAndBridgeTokens() public override {
        // Uniswap V2 router on Base lacks DAI/USDC liquidity; the source-side
        // swap happy path is covered end-to-end by the recorded mainnet run in
        // demoSuperset.ts (`base-to-unichain-w-swap` scenario, WETH→USDC).
    }

    /// @dev Stub swapData so the revert-path tests in `TestBaseFacet` work
    ///      without hitting `getAmountsIn` (the V2 DAI/USDC pool on Base has
    ///      ~$4 of liquidity, well under defaultUSDCAmount). The happy-path
    ///      swap test is overridden above; revert tests don't execute this
    ///      calldata.
    function setDefaultSwapDataSingleDAItoUSDC() internal override {
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_USDC;
        uint256 amountIn = 200 * 10 ** dai.decimals();

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: ADDRESS_USDC,
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapExactTokensForTokens.selector,
                    amountIn,
                    defaultUSDCAmount,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    /// @dev Same rationale as above; DAI/ETH liquidity on Base V2 is also too
    ///      thin to quote. Only used by `testRevert_NativeAssetNotSupported_SwapAndBridge`
    ///      which reverts before this calldata would execute.
    function setDefaultSwapDataSingleDAItoETH() internal override {
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = ADDRESS_WRAPPED_NATIVE;
        uint256 amountIn = 200 * 10 ** dai.decimals();

        swapData.push(
            LibSwap.SwapData({
                callTo: address(uniswap),
                approveTo: address(uniswap),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: address(0),
                fromAmount: amountIn,
                callData: abi.encodeWithSelector(
                    uniswap.swapTokensForExactETH.selector,
                    defaultNativeAmount,
                    amountIn,
                    path,
                    _facetTestContractAddress,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    // --- Constructor tests ---

    function test_CanDeployFacet() public {
        new SupersetFacet(SPOKE_POOL_MANAGER);
    }

    function testRevert_WhenPoolManagerIsZero() public {
        vm.expectRevert(InvalidConfig.selector);

        new SupersetFacet(address(0));
    }

    function test_IsHubDerivedFromChainId() public {
        // Non-hub: current fork is Base (id 8453)
        SupersetFacet nonHubFacet = new SupersetFacet(SPOKE_POOL_MANAGER);
        assertFalse(nonHubFacet.IS_HUB());

        // Hub: switch chainId to Arbitrum before constructing
        vm.chainId(42161);
        SupersetFacet hubFacet = new SupersetFacet(SPOKE_POOL_MANAGER);
        assertTrue(hubFacet.IS_HUB());
    }

    // --- Validation tests ---

    function testRevert_NativeAssetNotSupported_Bridge() public {
        vm.startPrank(USER_SENDER);
        bridgeData.sendingAssetId = address(0);
        bridgeData.minAmount = 1 ether;

        vm.expectRevert(NativeAssetNotSupported.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: bridgeData.minAmount + validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_NativeAssetNotSupported_SwapAndBridge() public {
        vm.startPrank(USER_SENDER);
        bridgeData.sendingAssetId = address(0);
        bridgeData.hasSourceSwaps = true;
        bridgeData.minAmount = 1 ether;
        setDefaultSwapDataSingleDAItoETH();

        vm.expectRevert(NativeAssetNotSupported.selector);

        supersetFacet.swapAndStartBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, swapData, validSupersetData);
    }

    function testRevert_DestinationCallNotSupported() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasDestinationCall = true;

        vm.expectRevert(InformationMismatch.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_EmptyPath() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.path = "";

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_ZeroAmountOutMin() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.amountOutMin = 0;

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_PathTokenMismatch() public {
        vm.startPrank(USER_SENDER);
        // Path's first omni-id (2 = USDC on the live Base book) does not match
        // the deposited/approved sendingAssetId (DAI).
        bridgeData.sendingAssetId = ADDRESS_DAI;
        bridgeData.minAmount = 100 * 10 ** dai.decimals();
        dai.approve(_facetTestContractAddress, bridgeData.minAmount);

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_SwapOutputTokenMismatch() public {
        vm.startPrank(USER_SENDER);
        bridgeData.sendingAssetId = ADDRESS_USDC;
        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.hasSourceSwaps = true;

        delete swapData;
        swapData.push(
            LibSwap.SwapData({
                callTo: ADDRESS_UNISWAP,
                approveTo: ADDRESS_UNISWAP,
                sendingAssetId: ADDRESS_USDC,
                // Last swap output (DAI) differs from the bridged token (USDC).
                receivingAssetId: ADDRESS_DAI,
                fromAmount: defaultUSDCAmount,
                callData: "",
                requiresDeposit: true
            })
        );

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.swapAndStartBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, swapData, validSupersetData);
    }

    function testRevert_FallbackEoAIsContract() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);

        validSupersetData.fallbackEoA = SPOKE_POOL_MANAGER;
        bridgeData.minAmount = defaultUSDCAmount;

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_InsufficientNativeValue() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;

        vm.expectRevert(SupersetFacet.InsufficientNativeValue.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee - 1
        }(bridgeData, validSupersetData);
    }

    function testRevert_DeadlineExpired() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.deadline = block.timestamp - 1;

        vm.expectRevert(DeadlineExpired.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_RefundRecipientIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.refundRecipient = address(0);

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_FallbackEoAIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.fallbackEoA = address(0);

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function test_RefundsExcessNativeToRefundRecipient() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.refundRecipient = USER_REFUND;

        uint256 refundBalanceBefore = USER_REFUND.balance;
        uint256 excess = 0.01 ether;

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee + excess
        }(bridgeData, validSupersetData);

        // Refund address gets at least the explicit excess; LayerZero may also
        // refund the difference between our generous lzFee budget and the live
        // quoted fee at the fork block.
        assertGe(USER_REFUND.balance, refundBalanceBefore + excess);
    }

    // --- Forwarding tests ---

    /// @dev The forwarding assertion is implicit: if any arg were wrong (path
    ///      decodes to a non-USDC token, deadline expired, fallbackEoA has
    ///      code, etc.) the real spoke would revert. We assert the source-side
    ///      side-effects: USDC pulled from the caller and `LiFiTransferStarted`
    ///      emitted with the exact bridgeData passed in.
    function test_ForwardsBridgeArgsToSpoke() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;

        uint256 senderBalanceBefore = usdc.balanceOf(USER_SENDER);

        vm.expectEmit(true, true, true, true, _facetTestContractAddress);
        emit LiFiTransferStarted(bridgeData);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);

        assertEq(
            usdc.balanceOf(USER_SENDER),
            senderBalanceBefore - defaultUSDCAmount
        );
    }

    function test_HubBranchForwardsArgsToHubAbi() public {
        // Switch the EVM chain id BEFORE construction so the facet's
        // IS_HUB immutable is set to true.
        vm.chainId(42161);

        MockSupersetHubPoolManager mockHub = new MockSupersetHubPoolManager();
        TestSupersetFacet hubFacet = new TestSupersetFacet(address(mockHub));

        // Standalone facet: diamond-storage owner defaults to address(0).
        vm.prank(address(0));
        hubFacet.initSuperset(_defaultChainIdConfigs());

        vm.startPrank(USER_SENDER);
        usdc.approve(address(hubFacet), defaultUSDCAmount);

        bridgeData.minAmount = defaultUSDCAmount;
        bridgeData.bridge = "superset";
        // destinationChainId must differ from chain id 42161
        bridgeData.destinationChainId = 130;

        // The hub mock resolves the first 32 bytes of `path` as an embedded
        // input-token address (test-only shortcut). The spoke path used
        // elsewhere encodes real omniTokenIds and is verified against the
        // live Base spoke contract.
        SupersetFacet.SupersetData memory hubData = validSupersetData;
        hubData.path = abi.encodePacked(
            bytes32(uint256(uint160(ADDRESS_USDC))),
            bytes3(uint24(3000)),
            bytes32(uint256(3))
        );

        hubFacet.startBridgeTokensViaSuperset{ value: hubData.lzFee }(
            bridgeData,
            hubData
        );

        (
            ,
            uint256 amountIn,
            ,
            address recipient,
            address fallbackEoA,
            ,
            uint32 toEid,
            uint256 lzFee,
            address inputToken
        ) = mockHub.lastCall();

        assertEq(amountIn, defaultUSDCAmount);
        assertEq(recipient, bridgeData.receiver);
        assertEq(fallbackEoA, hubData.fallbackEoA);
        assertEq(toEid, hubData.toEid);
        assertEq(lzFee, hubData.lzFee);
        assertEq(inputToken, ADDRESS_USDC);
    }

    // --- Positive slippage forwarding to amountOutMin ---

    function test_PositiveSlippageAdjustsAmountOutMin() public {
        MockFixedSwapRouter mockRouter = new MockFixedSwapRouter();
        supersetFacet.addAllowedContractSelector(
            address(mockRouter),
            MockFixedSwapRouter.swap.selector
        );

        // Swap floor on the post-swap token (DAI). Actual swap output is 2x the
        // floor — heavy positive slippage relative to backend's worst-case quote.
        uint256 swapFloorDAI = 100 * 10 ** dai.decimals();
        uint256 swapInputUSDC = defaultUSDCAmount;
        uint256 swapOutputDAI = 200 * 10 ** dai.decimals();
        deal(ADDRESS_DAI, address(mockRouter), swapOutputDAI);

        LibSwap.SwapData[] memory localSwaps = new LibSwap.SwapData[](1);
        localSwaps[0] = LibSwap.SwapData({
            callTo: address(mockRouter),
            approveTo: address(mockRouter),
            sendingAssetId: ADDRESS_USDC,
            receivingAssetId: ADDRESS_DAI,
            fromAmount: swapInputUSDC,
            callData: abi.encodeWithSelector(
                MockFixedSwapRouter.swap.selector,
                ADDRESS_USDC,
                ADDRESS_DAI,
                swapInputUSDC,
                swapOutputDAI,
                _facetTestContractAddress
            ),
            requiresDeposit: true
        });

        bridgeData.sendingAssetId = ADDRESS_DAI;
        // Backend-supplied swap floor — what `_depositAndSwap` enforces and what
        // the facet scales the destination floor against.
        bridgeData.minAmount = swapFloorDAI;
        bridgeData.hasSourceSwaps = true;

        SupersetFacet.SupersetData memory spokeData = validSupersetData;
        // Destination floor calibrated to the swap floor: 99 DAI (1% bridge
        // slippage on the 100 DAI floor).
        spokeData.amountOutMin = 99 * 10 ** dai.decimals();
        // Actual swap returns 2x → facet should scale the destination floor by 2×.
        uint256 expectedAmountOutMin = (spokeData.amountOutMin *
            swapOutputDAI) / swapFloorDAI;

        // Short-circuit the real spoke and verify the exact calldata + value.
        bytes memory expectedCalldata = abi.encodeCall(
            ISupersetSpokePoolManager.multiHopSwapWithOutputChain,
            (
                spokeData.path,
                swapOutputDAI,
                expectedAmountOutMin,
                bridgeData.receiver,
                spokeData.refundRecipient,
                spokeData.fallbackEoA,
                spokeData.deadline,
                spokeData.toEid,
                spokeData.options
            )
        );

        // The path reuses omni-id 2 (USDC on the live book) but this scenario
        // bridges DAI, so stub the resolver to bind id 2 → DAI for the facet's
        // path-token check.
        MockOmniTokenAddressBook book = new MockOmniTokenAddressBook();
        book.setToken(2, ADDRESS_DAI);
        vm.mockCall(
            SPOKE_POOL_MANAGER,
            abi.encodeCall(ISupersetPoolManager.getOmniTokenAddressBook, ()),
            abi.encode(address(book))
        );

        vm.mockCall(SPOKE_POOL_MANAGER, expectedCalldata, "");
        vm.expectCall(SPOKE_POOL_MANAGER, spokeData.lzFee, expectedCalldata);

        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, swapInputUSDC);

        supersetFacet.swapAndStartBridgeTokensViaSuperset{
            value: spokeData.lzFee
        }(bridgeData, localSwaps, spokeData);
    }

    // --- Chain mapping admin tests ---

    function test_DefaultChainMappingsSeeded() public {
        assertEq(supersetFacet.getChainIdToEid(42161), 30110);
        assertEq(supersetFacet.getChainIdToEid(8453), 30184);
        assertEq(supersetFacet.getChainIdToEid(130), 30320);
    }

    function testRevert_GetChainIdToEidUnsupported() public {
        vm.expectRevert(
            abi.encodeWithSelector(UnsupportedChainId.selector, 99999)
        );

        supersetFacet.getChainIdToEid(99999);
    }

    function test_CanSetChainIdToEid() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](1);
        configs[0] = SupersetFacet.ChainIdConfig({
            chainId: 999,
            lzEid: 30364
        });

        vm.expectEmit(true, true, true, true);
        emit ChainIdToEidSet(999, 30364);

        supersetFacet.setChainIdToEid(configs);

        assertEq(supersetFacet.getChainIdToEid(999), 30364);

        // Updating an existing entry overwrites it and re-emits.
        configs[0].lzEid = 40231;

        vm.expectEmit(true, true, true, true);
        emit ChainIdToEidSet(999, 40231);

        supersetFacet.setChainIdToEid(configs);

        assertEq(supersetFacet.getChainIdToEid(999), 40231);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToEidFromNonOwner() public {
        vm.startPrank(USER_SENDER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](1);
        configs[0] = SupersetFacet.ChainIdConfig({
            chainId: 999,
            lzEid: 30364
        });

        vm.expectRevert(OnlyContractOwner.selector);

        supersetFacet.setChainIdToEid(configs);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToEidEmpty() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](0);

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.setChainIdToEid(configs);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToEidZeroChainId() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](1);
        configs[0] = SupersetFacet.ChainIdConfig({ chainId: 0, lzEid: 30364 });

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.setChainIdToEid(configs);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToEidZeroEid() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](1);
        configs[0] = SupersetFacet.ChainIdConfig({ chainId: 999, lzEid: 0 });

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.setChainIdToEid(configs);

        vm.stopPrank();
    }

    function testRevert_SetChainIdToEidBeforeInit() public {
        TestSupersetFacet fresh = new TestSupersetFacet(SPOKE_POOL_MANAGER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](1);
        configs[0] = SupersetFacet.ChainIdConfig({
            chainId: 999,
            lzEid: 30364
        });

        vm.prank(address(0));
        vm.expectRevert(NotInitialized.selector);

        fresh.setChainIdToEid(configs);
    }

    function test_InitSupersetEmitsAndSetsMappings() public {
        TestSupersetFacet fresh = new TestSupersetFacet(SPOKE_POOL_MANAGER);
        SupersetFacet.ChainIdConfig[]
            memory configs = _defaultChainIdConfigs();

        vm.prank(address(0));
        // Per-entry ChainIdToEidSet events fire first, in config order…
        vm.expectEmit(true, true, true, true);
        emit ChainIdToEidSet(configs[0].chainId, configs[0].lzEid);
        vm.expectEmit(true, true, true, true);
        emit ChainIdToEidSet(configs[1].chainId, configs[1].lzEid);
        vm.expectEmit(true, true, true, true);
        emit ChainIdToEidSet(configs[2].chainId, configs[2].lzEid);
        // …followed by the batch confirmation.
        vm.expectEmit(true, true, true, true);
        emit SupersetChainMappingsInitialized(configs);

        fresh.initSuperset(configs);

        assertEq(fresh.getChainIdToEid(42161), 30110);
        assertEq(fresh.getChainIdToEid(8453), 30184);
        assertEq(fresh.getChainIdToEid(130), 30320);
    }

    function testRevert_InitSupersetFromNonOwner() public {
        vm.startPrank(USER_SENDER);

        vm.expectRevert(OnlyContractOwner.selector);

        supersetFacet.initSuperset(_defaultChainIdConfigs());

        vm.stopPrank();
    }

    function testRevert_InitSupersetEmpty() public {
        vm.startPrank(USER_DIAMOND_OWNER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](0);

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.initSuperset(configs);

        vm.stopPrank();
    }

    function testRevert_InitSupersetZeroChainId() public {
        TestSupersetFacet fresh = new TestSupersetFacet(SPOKE_POOL_MANAGER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](1);
        configs[0] = SupersetFacet.ChainIdConfig({ chainId: 0, lzEid: 30364 });

        vm.prank(address(0));
        vm.expectRevert(InvalidConfig.selector);

        fresh.initSuperset(configs);
    }

    function testRevert_InitSupersetZeroEid() public {
        TestSupersetFacet fresh = new TestSupersetFacet(SPOKE_POOL_MANAGER);

        SupersetFacet.ChainIdConfig[]
            memory configs = new SupersetFacet.ChainIdConfig[](1);
        configs[0] = SupersetFacet.ChainIdConfig({ chainId: 999, lzEid: 0 });

        vm.prank(address(0));
        vm.expectRevert(InvalidConfig.selector);

        fresh.initSuperset(configs);
    }

    // --- Destination chain validation tests ---

    function testRevert_DestinationChainIdMismatch() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        // destinationChainId is 130 (Unichain), but supply Arbitrum's EID.
        validSupersetData.toEid = 30110;

        vm.expectRevert(InvalidConfig.selector);

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }

    function testRevert_DestinationChainIdUnsupported() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        // Solana's LI.FI chain id has no LayerZero EID mapping.
        bridgeData.destinationChainId = 1151111081099710;

        vm.expectRevert(
            abi.encodeWithSelector(
                UnsupportedChainId.selector,
                1151111081099710
            )
        );

        supersetFacet.startBridgeTokensViaSuperset{
            value: validSupersetData.lzFee
        }(bridgeData, validSupersetData);
    }
}
