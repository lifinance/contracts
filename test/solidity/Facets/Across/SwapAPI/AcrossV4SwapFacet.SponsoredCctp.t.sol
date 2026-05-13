// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { AcrossV4SwapFacetSponsoredTestBase } from "./AcrossV4SwapFacet.SponsoredBase.t.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ISponsoredCCTPSrcPeriphery } from "lifi/Interfaces/ISponsoredCCTPSrcPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

contract AcrossV4SwapFacetSponsoredCctpTest is
    AcrossV4SwapFacetSponsoredTestBase
{
    function test_SponsoredCctp_PositiveSlippage_RefundsAfterValidation()
        public
    {
        uint256 quotedAmount = 100;
        uint256 swapOutputAmount = quotedAmount + 1;

        LibSwap.SwapData[] memory swapData = _swapDataDaiToTokenOut(
            quotedAmount,
            swapOutputAmount
        );

        ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote;
        quote.destinationDomain = 0; // chainId=1
        quote.finalRecipient = bytes32(uint256(uint160(USER_RECEIVER)));
        quote.amount = quotedAmount;
        quote.burnToken = bytes32(uint256(uint160(address(tokenOut))));

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "tx",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: address(tokenOut),
            receiver: USER_RECEIVER,
            minAmount: quotedAmount,
            destinationChainId: 1,
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        address refundRecipient = USER_RECEIVER;
        uint256 refundBalBefore = tokenOut.balanceOf(refundRecipient);

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        facet.swapAndStartBridgeTokensViaAcrossV4Swap(
            bridgeData,
            swapData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, bytes(""), refundRecipient),
                signature: ""
            })
        );
        vm.stopPrank();

        assertEq(tokenOut.balanceOf(refundRecipient), refundBalBefore + 1);
    }
}
