// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ERC20 } from "solmate/tokens/ERC20.sol";
import { TestBase } from "../../../utils/TestBase.sol";
import { TestHelpers } from "../../../utils/TestHelpers.sol";
import { TestWhitelistManagerBase } from "../../../utils/TestWhitelistManagerBase.sol";
import { MockUniswapDEX } from "../../../utils/MockUniswapDEX.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ISpokePoolPeriphery } from "lifi/Interfaces/ISpokePoolPeriphery.sol";
import { ISponsoredOFTSrcPeriphery } from "lifi/Interfaces/ISponsoredOFTSrcPeriphery.sol";
import { ISponsoredCCTPSrcPeriphery } from "lifi/Interfaces/ISponsoredCCTPSrcPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

// Minimal stub facet (for Diamond addFacet)
contract TestAcrossV4SwapFacetSponsoredRefunds is
    AcrossV4SwapFacet,
    TestWhitelistManagerBase
{
    constructor(
        ISpokePoolPeriphery _spokePoolPeriphery,
        address _spokePool,
        address _wrappedNative,
        address _sponsoredOftSrcPeriphery,
        address _sponsoredCctpSrcPeriphery,
        address _backendSigner
    )
        AcrossV4SwapFacet(
            _spokePoolPeriphery,
            _spokePool,
            _wrappedNative,
            _sponsoredOftSrcPeriphery,
            _sponsoredCctpSrcPeriphery,
            _backendSigner
        )
    {}
}

contract AcrossV4SwapFacetSponsoredRefundsTest is TestBase, TestHelpers {
    // Arbitrum token addresses (native USDC on Arbitrum One)
    address internal constant USDC_ARBITRUM =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    // Periphery callData (no selector), sourced from real Arbitrum transactions:
    // - Sponsored CCTP depositForBurn: `https://arbiscan.io/tx/0x4fb708325884739c1e22614b758e8baa31f8b6e6ea788d361638e98449105ccc`
    // - Sponsored OFT deposit: `https://arbiscan.io/tx/0xc2fae15f28177057b021ba6cb1f992420d47cdb77d3833789dbba835dc72f269`
    bytes internal constant SPONSORED_CCTP_CALLDATA =
        hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000013000000000000000000000000478d451e101be484880a14cf3ccc293cd48e61400000000000000000000000000000000000000000000000000000000005d6ea8d000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000478d451e101be484880a14cf3ccc293cd48e614000000000000000000000000000000000000000000000000000000000000031c100000000000000000000000000000000000000000000000000000000000003e82d22a8061c2e15ba06891704dafd0eb65a468a8d44e9ac5f001fff2ceaea301f0000000000000000000000000000000000000000000000000000000069c4f6e8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000ce91663bf5b7d8c423d10b34555394ed54a7d8be000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004109e648b3f497ab857d440356d921b9ed7be091e77bbf96cb7b1bf5c97aaea079731f7657efa8dbe3cd5f58c6afe07ee4d266245589ffd2b17e5b08fe931fa9d41b000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";
    bytes internal constant SPONSORED_OFT_CALLDATA =
        hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000000400000000000000000000000009a8f92a830a5cb89a3816e3d267cb7791c16b04d000000000000000000000000000000000000000000000000000000000000759e000000000000000000000000000000000000000000000000000000000000769f0000000000000000000000000ca8316a6fcc15c833a220c40d84550b0833943800000000000000000000000000000000000000000000000000000000000f42400e2fd0a7e9cad4c6a5455041b8fcc545f190a17604c4e7c1f70227a7b7da1aeb0000000000000000000000000000000000000000000000000000000069c44e73000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f40000000000000000000000009a8f92a830a5cb89a3816e3d267cb7791c16b04d000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002ab9800000000000000000000000000000000000000000000000000000000000493e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000416b0a8d27a220885480a8634c001d2e1d260558429f76e71d651b06600253ce73224ed0ddb3386e309d85c84f02c82ab9aa8a11d521598b1555bd732f51472faa1b000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";

    AcrossV4SwapFacet internal acrossV4SwapFacet;
    address internal sponsoredOftSrcPeriphery;
    address internal sponsoredCctpSrcPeriphery;
    address internal backendSigner;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        // Before fixture txs (OFT 445622005, CCTP 445794801) so quote nonces are unused; archive RPC.
        customBlockNumberForForking = 445622003;
        initTestBase();

        backendSigner = vm.addr(0xA11CE);

        address spokePoolPeriphery = getConfigAddressFromPath(
            "across.json",
            ".arbitrum.spokePoolPeriphery"
        );
        address spokePool = getConfigAddressFromPath(
            "across.json",
            ".arbitrum.acrossSpokePool"
        );
        address wrappedNative = getConfigAddressFromPath(
            "networks.json",
            ".arbitrum.wrappedNativeAddress"
        );
        sponsoredOftSrcPeriphery = getConfigAddressFromPath(
            "across.json",
            ".arbitrum.sponsoredOftSrcPeriphery"
        );
        sponsoredCctpSrcPeriphery = getConfigAddressFromPath(
            "across.json",
            ".arbitrum.sponsoredCctpSrcPeriphery"
        );

        TestAcrossV4SwapFacetSponsoredRefunds facetImpl = new TestAcrossV4SwapFacetSponsoredRefunds(
                ISpokePoolPeriphery(spokePoolPeriphery),
                spokePool,
                wrappedNative,
                sponsoredOftSrcPeriphery,
                sponsoredCctpSrcPeriphery,
                backendSigner
            );

        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = facetImpl
            .startBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[1] = facetImpl
            .swapAndStartBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[2] = facetImpl.addAllowedContractSelector.selector;
        addFacet(diamond, address(facetImpl), functionSelectors);

        acrossV4SwapFacet = AcrossV4SwapFacet(address(diamond));
        setFacetAddressInTestBase(address(diamond), "AcrossV4SwapFacet");
    }

    function _decodeSponsoredOftWithRefundRecipient(
        address refundRecipient
    )
        internal
        pure
        returns (
            ISponsoredOFTSrcPeriphery.Quote memory quote,
            bytes memory signature,
            bytes memory callData
        )
    {
        (quote, signature) = abi.decode(
            SPONSORED_OFT_CALLDATA,
            (ISponsoredOFTSrcPeriphery.Quote, bytes)
        );
        quote.unsignedParams.refundRecipient = refundRecipient;
        callData = abi.encode(quote, signature);
    }

    /// @param _refundRecipient Address to receive positive-slippage refunds (used in facet callData).
    function _decodeSponsoredCctp(
        address _refundRecipient
    )
        internal
        pure
        returns (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature,
            bytes memory callData
        )
    {
        (quote, signature) = abi.decode(
            SPONSORED_CCTP_CALLDATA,
            (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
        );
        callData = abi.encode(quote, signature, _refundRecipient);
    }

    function _setSwapDataDaiToTokenAndDeployMockDex(
        address outputToken,
        uint256 amountOutMin,
        uint256 outputAmount,
        address receiver
    ) internal returns (MockUniswapDEX mockDEX) {
        mockDEX = deployFundAndWhitelistMockDEX(
            receiver,
            outputToken,
            outputAmount,
            0
        );

        delete swapData;
        address[] memory path = new address[](2);
        path[0] = ADDRESS_DAI;
        path[1] = outputToken;
        swapData.push(
            LibSwap.SwapData({
                callTo: address(mockDEX),
                approveTo: address(mockDEX),
                sendingAssetId: ADDRESS_DAI,
                receivingAssetId: outputToken,
                fromAmount: 100 * 10 ** 18,
                callData: abi.encodeWithSelector(
                    mockDEX.swapExactTokensForTokens.selector,
                    100 * 10 ** 18,
                    amountOutMin,
                    path,
                    receiver,
                    block.timestamp + 20 minutes
                ),
                requiresDeposit: true
            })
        );
    }

    function test_SponsoredOft_PositiveSlippage_RefundsToQuoteRefundRecipient()
        public
    {
        address refundRecipient = USER_RECEIVER;
        (
            ISponsoredOFTSrcPeriphery.Quote memory quote,
            bytes memory signature,
            bytes memory peripheryCallData
        ) = _decodeSponsoredOftWithRefundRecipient(refundRecipient);

        uint256 quotedAmount = quote.signedParams.amountLD;
        uint256 swapOutputAmount = quotedAmount + 1;

        _setSwapDataDaiToTokenAndDeployMockDex(
            ADDRESS_USDT,
            quotedAmount,
            swapOutputAmount,
            address(diamond)
        );

        ILiFi.BridgeData memory localBridgeData;
        localBridgeData.transactionId = "someId";
        localBridgeData.bridge = "acrossV4Swap";
        localBridgeData.integrator = "";
        localBridgeData.referrer = address(0);
        localBridgeData.sendingAssetId = ADDRESS_USDT;
        localBridgeData.receiver = address(
            uint160(uint256(quote.signedParams.finalRecipient))
        );
        localBridgeData.minAmount = quotedAmount;
        localBridgeData.destinationChainId = 999;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.hasDestinationCall = false;

        AcrossV4SwapFacet.AcrossV4SwapFacetData memory facetData;
        facetData.swapApiTarget = AcrossV4SwapFacet
            .SwapApiTarget
            .SponsoredOFTSrcPeriphery;
        facetData.callData = peripheryCallData;
        facetData.signature = "";

        uint256 refundAmount = swapOutputAmount - quotedAmount;
        uint256 refundBalanceBefore = usdt.balanceOf(refundRecipient);

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        // Expect the periphery call to use the original (signed) quote amount.
        vm.expectCall(
            sponsoredOftSrcPeriphery,
            abi.encodeWithSelector(
                ISponsoredOFTSrcPeriphery.deposit.selector,
                quote,
                signature
            )
        );

        acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap{
            value: 0.01 ether
        }(localBridgeData, swapData, facetData);
        vm.stopPrank();

        assertEq(
            usdt.balanceOf(refundRecipient),
            refundBalanceBefore + refundAmount
        );
    }

    function testRevert_SponsoredOft_PositiveSlippage_WhenRefundRecipientZero()
        public
    {
        address refundRecipient = address(0);
        (
            ISponsoredOFTSrcPeriphery.Quote memory quote,
            ,
            bytes memory peripheryCallData
        ) = _decodeSponsoredOftWithRefundRecipient(refundRecipient);

        uint256 quotedAmount = quote.signedParams.amountLD;
        uint256 swapOutputAmount = quotedAmount + 1;

        _setSwapDataDaiToTokenAndDeployMockDex(
            ADDRESS_USDT,
            quotedAmount,
            swapOutputAmount,
            address(diamond)
        );

        ILiFi.BridgeData memory localBridgeData;
        localBridgeData.transactionId = "someId";
        localBridgeData.bridge = "acrossV4Swap";
        localBridgeData.integrator = "";
        localBridgeData.referrer = address(0);
        localBridgeData.sendingAssetId = ADDRESS_USDT;
        localBridgeData.receiver = address(
            uint160(uint256(quote.signedParams.finalRecipient))
        );
        localBridgeData.minAmount = quotedAmount;
        localBridgeData.destinationChainId = 999;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.hasDestinationCall = false;

        AcrossV4SwapFacet.AcrossV4SwapFacetData memory facetData;
        facetData.swapApiTarget = AcrossV4SwapFacet
            .SwapApiTarget
            .SponsoredOFTSrcPeriphery;
        facetData.callData = peripheryCallData;
        facetData.signature = "";

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap{
            value: 0.01 ether
        }(localBridgeData, swapData, facetData);
        vm.stopPrank();
    }

    function test_SponsoredCctp_PositiveSlippage_RefundsToRefundRecipient()
        public
    {
        address refundRecipient = USER_RECEIVER;
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature,
            bytes memory peripheryCallData
        ) = _decodeSponsoredCctp(refundRecipient);

        // Quote amount is what must be bridged; any surplus will be refunded to msg.sender.
        uint256 quotedAmount = quote.amount;
        uint256 swapOutputAmount = quotedAmount + 1;

        // Mock swap: DAI -> native USDC on Arbitrum (burnToken).
        _setSwapDataDaiToTokenAndDeployMockDex(
            USDC_ARBITRUM,
            quotedAmount,
            swapOutputAmount,
            address(diamond)
        );

        ILiFi.BridgeData memory localBridgeData;
        localBridgeData.transactionId = "someId";
        localBridgeData.bridge = "acrossV4Swap";
        localBridgeData.integrator = "";
        localBridgeData.referrer = address(0);
        localBridgeData.sendingAssetId = USDC_ARBITRUM;
        localBridgeData.receiver = address(
            uint160(uint256(quote.finalRecipient))
        );
        localBridgeData.minAmount = quotedAmount;
        localBridgeData.destinationChainId = 999;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.hasDestinationCall = false;

        AcrossV4SwapFacet.AcrossV4SwapFacetData memory facetData;
        facetData.swapApiTarget = AcrossV4SwapFacet
            .SwapApiTarget
            .SponsoredCCTPSrcPeriphery;
        facetData.callData = peripheryCallData;
        facetData.signature = "";

        uint256 refundAmount = swapOutputAmount - quotedAmount;
        uint256 refundRecipientBalBefore = ERC20(USDC_ARBITRUM).balanceOf(
            refundRecipient
        );

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        vm.expectCall(
            sponsoredCctpSrcPeriphery,
            abi.encodeWithSelector(
                ISponsoredCCTPSrcPeriphery.depositForBurn.selector,
                quote,
                signature
            )
        );

        acrossV4SwapFacet.swapAndStartBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            swapData,
            facetData
        );
        vm.stopPrank();

        assertEq(
            ERC20(USDC_ARBITRUM).balanceOf(refundRecipient),
            refundRecipientBalBefore + refundAmount
        );
    }
}
