// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { AcrossV4SwapFacetSponsoredTestBase } from "./AcrossV4SwapFacet.SponsoredBase.t.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ISponsoredOFTSrcPeriphery } from "lifi/Interfaces/ISponsoredOFTSrcPeriphery.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InformationMismatch } from "lifi/Errors/GenericErrors.sol";

contract AcrossV4SwapFacetSponsoredOftTest is
    AcrossV4SwapFacetSponsoredTestBase
{
    function testRevert_SponsoredOft_WhenDstEidMismatch() public {
        ISponsoredOFTSrcPeriphery.Quote memory quote;
        quote.signedParams.dstEid = 999; // mismatch for chainId=1 (30101)
        quote.signedParams.amountLD = 123;
        quote.signedParams.finalRecipient = bytes32(
            uint256(uint160(USER_RECEIVER))
        );

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "tx",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: address(tokenOut),
            receiver: USER_RECEIVER,
            minAmount: quote.signedParams.amountLD,
            destinationChainId: 1,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        tokenOut.mint(USER_SENDER, bridgeData.minAmount);

        vm.startPrank(USER_SENDER);
        tokenOut.approve(address(diamond), bridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        facet.startBridgeTokensViaAcrossV4Swap(
            bridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: abi.encode(quote, bytes("")),
                signature: ""
            })
        );
        vm.stopPrank();
    }

    function test_SponsoredOft_PositiveSlippage_RefundsAfterValidation()
        public
    {
        uint256 quotedAmount = 100;
        uint256 swapOutputAmount = quotedAmount + 1;

        LibSwap.SwapData[] memory swapData = _swapDataDaiToTokenOut(
            quotedAmount,
            swapOutputAmount
        );

        ISponsoredOFTSrcPeriphery.Quote memory quote;
        quote.signedParams.dstEid = 30101; // chainId=1
        quote.signedParams.amountLD = quotedAmount;
        quote.signedParams.finalRecipient = bytes32(
            uint256(uint160(USER_RECEIVER))
        );
        quote.unsignedParams.refundRecipient = USER_RECEIVER;

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

        uint256 refundBalBefore = tokenOut.balanceOf(USER_RECEIVER);

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        facet.swapAndStartBridgeTokensViaAcrossV4Swap(
            bridgeData,
            swapData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: abi.encode(quote, bytes("")),
                signature: ""
            })
        );
        vm.stopPrank();

        assertEq(tokenOut.balanceOf(USER_RECEIVER), refundBalBefore + 1);
    }
}
