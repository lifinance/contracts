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

// Minimal stub facet (for Diamond addFacet)
contract TestAcrossV4SwapFacetSponsoredRefunds is
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

contract AcrossV4SwapFacetSponsoredRefundsTest is TestBase, TestHelpers {
    // Arbitrum token addresses (native USDC on Arbitrum One)
    address internal constant USDC_ARBITRUM =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;

    // Periphery callData (no selector), sourced from real Arbitrum transactions:
    // - Sponsored CCTP depositForBurn: `https://arbiscan.io/tx/0x58e7603e5e442ddc33f8cc78f20ca1193519589a5085b0233ed5ab069afcfbc5`
    // - Sponsored OFT deposit: `https://arbiscan.io/tx/0xebb4c5303972f84ac9bff42a106f23fe04773bee0119f6521f3a0fae8db60edb`
    bytes internal constant SPONSORED_CCTP_CALLDATA =
        hex"00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000130000000000000000000000001c709fd0db6a6b877ddb19ae3d485b7b4add879f000000000000000000000000000000000000000000000000000000040e225440000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000001c709fd0db6a6b877ddb19ae3d485b7b4add879f0000000000000000000000000000000000000000000000000000000000228c9200000000000000000000000000000000000000000000000000000000000003e88c29807243f39dc62a658288c3da78b0f9f0491128a6d4ad8c6fb180000cd1440000000000000000000000000000000000000000000000000000000069681798000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000f961e5e6c5276164adb2865b7e80cf82dc04e920000000000000000000000000111111a1a0667d36bd57c0a9f569b98057111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004146c1b04bb28d876845ad77693b8854efcbae821becd2f3ee69ce7c1c99af34f75f2787bd8e94c33d2a779b3868a2f17acb4b11b8842a4561c8115471c7800d371b000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";
    bytes internal constant SPONSORED_OFT_CALLDATA =
        hex"00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000759e000000000000000000000000000000000000000000000000000000000000769f000000000000000000000000c8786d517b4e224bb43985a38dbef8588d7354cd00000000000000000000000000000000000000000000000000000000004c4b40d68523e6dfa620bda28fce2092480828305416d2b5b091b9560985325e699570000000000000000000000000000000000000000000000000000000006967c89000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000404dc936b5ce2f01cd80ede9cd4e5809a483d32000000000000000000000000b8ce59fc3717ada4c02eadf9682a9e934f625ebb000000000000000000000000000000000000000000000000000000000002ab9800000000000000000000000000000000000000000000000000000000000493e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000411442fc1a5c7c2df5cbc0ff83364521cf33be93aea0e0881b4a1009bae8aba16d50ba7f74ba7605f0e4463af5fd7a129c60595baccca434b0ca4b07be626b2f6f1c000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";

    AcrossV4SwapFacet internal acrossV4SwapFacet;
    address internal sponsoredOftSrcPeriphery;
    address internal sponsoredCctpSrcPeriphery;

    function setUp() public {
        customRpcUrlForForking = "ETH_NODE_URI_ARBITRUM";
        customBlockNumberForForking = 421327371;
        initTestBase();

        address spokePoolPeriphery = getConfigAddressFromPath(
            "acrossV4Swap.json",
            ".arbitrum.spokePoolPeriphery"
        );
        address spokePool = getConfigAddressFromPath(
            "acrossV4Swap.json",
            ".arbitrum.spokePool"
        );
        sponsoredOftSrcPeriphery = getConfigAddressFromPath(
            "acrossV4Swap.json",
            ".arbitrum.sponsoredOftSrcPeriphery"
        );
        sponsoredCctpSrcPeriphery = getConfigAddressFromPath(
            "acrossV4Swap.json",
            ".arbitrum.sponsoredCctpSrcPeriphery"
        );

        TestAcrossV4SwapFacetSponsoredRefunds facetImpl = new TestAcrossV4SwapFacetSponsoredRefunds(
                ISpokePoolPeriphery(spokePoolPeriphery),
                spokePool,
                sponsoredOftSrcPeriphery,
                sponsoredCctpSrcPeriphery
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

    function _decodeSponsoredCctp()
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
        callData = abi.encode(quote, signature);
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
        localBridgeData.destinationChainId = 1;
        localBridgeData.hasSourceSwaps = true;
        localBridgeData.hasDestinationCall = false;

        AcrossV4SwapFacet.AcrossV4SwapFacetData memory facetData;
        facetData.swapApiTarget = AcrossV4SwapFacet
            .SwapApiTarget
            .SponsoredOFTSrcPeriphery;
        facetData.callData = peripheryCallData;

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

    function test_SponsoredCctp_PositiveSlippage_RefundsToMsgSender() public {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature,
            bytes memory peripheryCallData
        ) = _decodeSponsoredCctp();

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

        uint256 refundAmount = swapOutputAmount - quotedAmount;
        uint256 senderBalBefore = ERC20(USDC_ARBITRUM).balanceOf(USER_SENDER);

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
            ERC20(USDC_ARBITRUM).balanceOf(USER_SENDER),
            senderBalBefore + refundAmount
        );
    }
}
