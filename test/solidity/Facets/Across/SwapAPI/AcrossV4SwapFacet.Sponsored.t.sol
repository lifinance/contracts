// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../../../utils/TestBase.sol";
import { TestWhitelistManagerBase } from "../../../utils/TestWhitelistManagerBase.sol";
import { TestHelpers, MockUniswapDEX } from "../../../utils/TestHelpers.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ISpokePoolPeriphery } from "lifi/Interfaces/ISpokePoolPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InvalidConfig, InformationMismatch, InvalidCallData } from "lifi/Errors/GenericErrors.sol";

// Minimal stub facet (for Diamond addFacet)
contract TestAcrossV4SwapFacetSponsored is
    AcrossV4SwapFacet,
    TestWhitelistManagerBase
{
    constructor(
        ISpokePoolPeriphery _spokePoolPeriphery,
        address _spokePool,
        address _sponsoredOftSrcPeriphery,
        address _sponsoredCctpSrcPeriphery
    )
        AcrossV4SwapFacet(
            _spokePoolPeriphery,
            _spokePool,
            _sponsoredOftSrcPeriphery,
            _sponsoredCctpSrcPeriphery
        )
    {}
}

/// @dev Exposes internal Sponsored CCTP logic to cover otherwise unreachable branches.
contract TestAcrossV4SwapFacetSponsoredHarness is
    AcrossV4SwapFacet,
    TestWhitelistManagerBase
{
    constructor(
        ISpokePoolPeriphery _spokePoolPeriphery,
        address _spokePool,
        address _sponsoredOftSrcPeriphery,
        address _sponsoredCctpSrcPeriphery
    )
        AcrossV4SwapFacet(
            _spokePoolPeriphery,
            _spokePool,
            _sponsoredOftSrcPeriphery,
            _sponsoredCctpSrcPeriphery
        )
    {}

    function exposed_callSponsoredCctpDepositForBurn(
        ILiFi.BridgeData memory _bridgeData,
        bytes calldata _callData
    ) external payable {
        _callSponsoredCctpDepositForBurn(_bridgeData, _callData, 0);
    }
}

contract MockSpokePoolPeriphery is ISpokePoolPeriphery {
    function swapAndBridge(SwapAndDepositData calldata) external payable {}
}

/// @dev Accepts any calldata (so typed calls from the facet won't revert due to missing selectors).
contract CalldataSink {
    fallback() external payable {}
    receive() external payable {}
}

/// @notice Sponsored-flow focused tests for AcrossV4SwapFacet
/// @dev Split out to isolate stack-too-deep compilation issues in legacy pipeline
contract AcrossV4SwapFacetSponsoredTest is TestBase, TestHelpers {
    // Mainnet addresses used by the core suite
    address internal constant SPOKE_POOL =
        0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5;
    address internal constant WETH =
        0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC_MAINNET =
        0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT_MAINNET =
        0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant USDC_ARBITRUM =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    // Hard-coded ABI-encoded callData for Sponsored OFT (Quote, signature) @ amount=100e6
    function _sponsoredOftCallDataRefundRecipientUserRefund()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"0000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000026000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000abcdef28100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000";
    }

    function _sponsoredOftCallDataRefundRecipientZero()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000";
    }

    function _sponsoredOftCallDataRefundRecipientBeef()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000beef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005f5e1000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000";
    }

    // Hard-coded ABI-encoded callData for Sponsored CCTP (Quote, signature) @ destinationDomain=6, amount=100e6, burnToken=USDC_MAINNET
    function _sponsoredCctpCallDataDomain6BurnUsdc()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb4800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000";
    }

    function _sponsoredCctpCallDataDomain6BurnUsdt()
        internal
        pure
        returns (bytes memory)
    {
        return
            hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005f5e100000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000abc654321000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e583100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010100000000000000000000000000000000000000000000000000000000000000";
    }

    function _callDataForDomain(
        uint32 _destinationDomain
    ) internal pure returns (bytes memory) {
        bytes memory callData = _sponsoredCctpCallDataDomain6BurnUsdc();

        // ABI layout for `abi.encode(quote, signature)`:
        // - word0: offset to quote (0x40)
        // - word1: offset to signature
        // - quote starts at 0x40
        // - quote.word0 = sourceDomain
        // - quote.word1 = destinationDomain
        //
        // In bytes memory, data starts at +0x20, so destinationDomain is at:
        // 0x20 + 0x40 + 0x20 = 0x80.
        assembly {
            mstore(add(callData, 0x80), _destinationDomain)
        }

        return callData;
    }

    TestAcrossV4SwapFacetSponsored internal acrossV4SwapFacet;
    MockSpokePoolPeriphery internal mockPeriphery;

    function setUp() public {
        customBlockNumberForForking = 24067413;
        initTestBase();

        mockPeriphery = new MockSpokePoolPeriphery();
        CalldataSink mockSponsoredOft = new CalldataSink();
        CalldataSink mockSponsoredCctp = new CalldataSink();

        acrossV4SwapFacet = new TestAcrossV4SwapFacetSponsored(
            ISpokePoolPeriphery(address(mockPeriphery)),
            SPOKE_POOL,
            address(mockSponsoredOft),
            address(mockSponsoredCctp)
        );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = acrossV4SwapFacet
            .startBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[1] = acrossV4SwapFacet
            .swapAndStartBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[2] = acrossV4SwapFacet
            .addAllowedContractSelector
            .selector;

        addFacet(diamond, address(acrossV4SwapFacet), functionSelectors);
        acrossV4SwapFacet = TestAcrossV4SwapFacetSponsored(address(diamond));

        setFacetAddressInTestBase(
            address(acrossV4SwapFacet),
            "AcrossV4SwapFacetSponsored"
        );

        // Align bridgeData with mainnet -> Arbitrum scenario
        bridgeData.bridge = "acrossV4Swap";
        bridgeData.destinationChainId = 42161;
    }

    function testRevert_WhenConstructedWithZeroConfig() public {
        vm.expectRevert(InvalidConfig.selector);

        new TestAcrossV4SwapFacetSponsored(
            ISpokePoolPeriphery(address(0)),
            address(0),
            address(0),
            address(0)
        );
    }

    function test_CanBridgeViaSponsoredOft() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(bridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: _sponsoredOftCallDataRefundRecipientUserRefund()
            })
        );

        vm.stopPrank();
    }

    function testRevert_SponsoredOft_WhenRefundRecipientZero() public {
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), bridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: _sponsoredOftCallDataRefundRecipientZero()
            })
        );

        vm.stopPrank();
    }

    function testRevert_SponsoredOft_WhenNativeAsset() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.sendingAssetId = address(0);

        vm.startPrank(USER_SENDER);
        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap{
            value: localBridgeData.minAmount
        }(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: _sponsoredOftCallDataRefundRecipientUserRefund()
            })
        );

        vm.stopPrank();
    }

    function test_SponsoredOft_PositiveSlippageRefundsSurplusToRefundRecipient()
        public
    {
        // set up swap to return +10% USDC
        uint256 preSwapAmount = 100 * 10 ** 6;
        uint256 swapOutputAmount = 110 * 10 ** 6;

        // mock DEX funded with USDC
        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(acrossV4SwapFacet),
            USDC_MAINNET,
            swapOutputAmount,
            0
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            address(mockDEX),
            mockDEX.swapExactTokensForTokens.selector
        );

        // swap: DAI -> USDC
        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = USDC_MAINNET;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDEX),
                approveTo: address(mockDEX),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: USDC_MAINNET,
                fromAmount: 100 * 10 ** 18,
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18,
                    preSwapAmount,
                    path,
                    address(acrossV4SwapFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.minAmount = preSwapAmount;

        uint256 refundRecipientBalanceBefore = usdc.balanceOf(address(0xBEEF));

        vm.startPrank(USER_SENDER);
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);

        // Event uses the originally signed amount (preSwapAmount)
        ILiFi.BridgeData memory expectedEventData = localBridgeData;
        expectedEventData.minAmount = preSwapAmount;

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(expectedEventData);

        acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            swapData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: _sponsoredOftCallDataRefundRecipientBeef()
            })
        );

        vm.stopPrank();

        assertEq(
            usdc.balanceOf(address(0xBEEF)),
            refundRecipientBalanceBefore + (swapOutputAmount - preSwapAmount)
        );
    }

    function test_CanBridgeViaSponsoredCctp() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.destinationChainId = 8453; // Base -> domain 6

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(localBridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: _sponsoredCctpCallDataDomain6BurnUsdc()
            })
        );

        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenMsgValueNonZero() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.destinationChainId = 8453;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap{ value: 1 }(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: _sponsoredCctpCallDataDomain6BurnUsdc()
            })
        );

        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenBridgeDataAssetIsNative() public {
        // This branch can't be reached via the normal external entrypoint because native-asset
        // deposits require `msg.value`, but Sponsored CCTP is non-payable. We cover it via a harness.
        TestAcrossV4SwapFacetSponsoredHarness harness = new TestAcrossV4SwapFacetSponsoredHarness(
                ISpokePoolPeriphery(address(mockPeriphery)),
                SPOKE_POOL,
                address(new CalldataSink()),
                address(new CalldataSink())
            );

        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.destinationChainId = 8453; // Base -> domain 6
        localBridgeData.sendingAssetId = address(0);

        vm.expectRevert(InvalidCallData.selector);
        harness.exposed_callSponsoredCctpDepositForBurn(
            localBridgeData,
            _sponsoredCctpCallDataDomain6BurnUsdc()
        );
    }

    function testRevert_SponsoredCctp_WhenBurnTokenMismatch() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.destinationChainId = 8453;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: _sponsoredCctpCallDataDomain6BurnUsdt()
            })
        );

        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenDestinationDomainMismatch() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.destinationChainId = 8453; // domain 6

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: _callDataForDomain(7)
            })
        );

        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenChainIdNotMapped() public {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.destinationChainId = 9999999;

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: _callDataForDomain(6)
            })
        );

        vm.stopPrank();
    }

    function test_SponsoredCctp_PositiveSlippageRefundsSurplusToCaller()
        public
    {
        uint256 preSwapAmount = 100 * 10 ** 6;
        uint256 swapOutputAmount = 110 * 10 ** 6;

        MockUniswapDEX mockDEX = deployFundAndWhitelistMockDEX(
            address(acrossV4SwapFacet),
            USDC_MAINNET,
            swapOutputAmount,
            0
        );
        acrossV4SwapFacet.addAllowedContractSelector(
            address(mockDEX),
            mockDEX.swapExactTokensForTokens.selector
        );

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = USDC_MAINNET;

        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDEX),
                approveTo: address(mockDEX),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: USDC_MAINNET,
                fromAmount: 100 * 10 ** 18,
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18,
                    preSwapAmount,
                    path,
                    address(acrossV4SwapFacet),
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );

        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.sendingAssetId = USDC_MAINNET;
        localBridgeData.minAmount = preSwapAmount;
        localBridgeData.destinationChainId = 8453; // domain 6

        uint256 senderUsdcBalanceBefore = usdc.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        dai.approve(address(acrossV4SwapFacet), swapData[0].fromAmount);

        ILiFi.BridgeData memory expectedEventData = localBridgeData;
        expectedEventData.minAmount = preSwapAmount;

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(expectedEventData);

        acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            swapData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: _callDataForDomain(6)
            })
        );

        vm.stopPrank();

        assertEq(
            usdc.balanceOf(USER_SENDER),
            senderUsdcBalanceBefore + (swapOutputAmount - preSwapAmount)
        );
    }

    function test_SponsoredCctp_CoversAllMappedDomains() public {
        vm.chainId(999999);

        deal(USDC_MAINNET, USER_SENDER, 10_000_000 * 10 ** 6);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), type(uint256).max);

        // chainId -> domain
        _callSponsoredCctpMapped(1, 0);
        _callSponsoredCctpMapped(43114, 1);
        _callSponsoredCctpMapped(10, 2);
        _callSponsoredCctpMapped(42161, 3);
        _callSponsoredCctpMapped(1151111081099710, 5);
        _callSponsoredCctpMapped(8453, 6);
        _callSponsoredCctpMapped(137, 7);
        _callSponsoredCctpMapped(130, 10);
        _callSponsoredCctpMapped(59144, 11);
        _callSponsoredCctpMapped(81224, 12);
        _callSponsoredCctpMapped(146, 13);
        _callSponsoredCctpMapped(480, 14);
        _callSponsoredCctpMapped(1329, 16);
        _callSponsoredCctpMapped(50, 18);
        _callSponsoredCctpMapped(999, 19);
        _callSponsoredCctpMapped(57073, 21);
        _callSponsoredCctpMapped(98866, 22);

        vm.stopPrank();
    }

    function _callSponsoredCctpMapped(
        uint256 _destinationChainId,
        uint32 _destinationDomain
    ) internal {
        ILiFi.BridgeData memory localBridgeData = bridgeData;
        localBridgeData.destinationChainId = _destinationChainId;

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: _callDataForDomain(_destinationDomain)
            })
        );
    }
}
