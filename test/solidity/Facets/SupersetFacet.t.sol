// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibSwap } from "../utils/TestBase.sol";
import { TestBaseFacet } from "../utils/TestBaseFacet.sol";
import { SupersetFacet } from "lifi/Facets/SupersetFacet.sol";
import { ISupersetHubPoolManager } from "lifi/Interfaces/ISupersetHubPoolManager.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";
import { InvalidConfig, NativeAssetNotSupported, InformationMismatch } from "lifi/Errors/GenericErrors.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { TestWhitelistManagerBase } from "../utils/TestWhitelistManagerBase.sol";

/// @dev Hub-side mock — 7-arg ABI matching Superset's `HubPoolManager`.
contract MockSupersetHubPoolManager is ISupersetHubPoolManager {
    using SafeERC20 for IERC20;

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

contract TestSupersetFacet is SupersetFacet, TestWhitelistManagerBase {
    constructor(address _poolManager) SupersetFacet(_poolManager) {}
}

contract SupersetFacetTest is TestBaseFacet {
    // Real Superset spoke deployment on Base mainnet (see config/superset.json).
    address internal constant SPOKE_POOL_MANAGER =
        0x57C155a15a9CA0A6C1F759ac6988b4fCa3663Ea4;
    // Destination LayerZero EID for Unichain (used end-to-end by demoSuperset).
    uint32 internal constant TO_EID = 30320;
    // Generous native budget; spoke quotes a smaller amount from EndpointV2.quote()
    // and refunds the excess via `refundAddress`.
    uint256 internal constant LZ_FEE = 0.005 ether;

    TestSupersetFacet internal supersetFacet;
    SupersetFacet.SupersetData internal validSupersetData;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_BASE";
        customBlockNumberForForking = 46595000;
        initTestBase();

        supersetFacet = new TestSupersetFacet(SPOKE_POOL_MANAGER);

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = supersetFacet
            .startBridgeTokensViaSuperset
            .selector;
        functionSelectors[1] = supersetFacet
            .swapAndStartBridgeTokensViaSuperset
            .selector;
        functionSelectors[2] = supersetFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(supersetFacet), functionSelectors);
        supersetFacet = TestSupersetFacet(payable(address(diamond)));
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
            amountOutMinPercent: 0.99e18,
            refundAddress: USER_SENDER,
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

    function testRevert_RefundAddressIsZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.refundAddress = address(0);

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

    function test_RefundsExcessNativeToRefundAddress() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(_facetTestContractAddress, defaultUSDCAmount);
        bridgeData.minAmount = defaultUSDCAmount;
        validSupersetData.refundAddress = USER_REFUND;

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
}
