// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "../../../utils/DiamondTest.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ISpokePoolPeriphery } from "lifi/Interfaces/ISpokePoolPeriphery.sol";
import { ISponsoredCCTPSrcPeriphery } from "lifi/Interfaces/ISponsoredCCTPSrcPeriphery.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { InformationMismatch } from "lifi/Errors/GenericErrors.sol";
import { TestWhitelistManagerBase } from "../../../utils/TestWhitelistManagerBase.sol";
import { MockUniswapDEX } from "../../../utils/MockUniswapDEX.sol";
import { TestToken } from "../../../utils/TestToken.sol";

contract RevertingToken is TestToken {
    error RefundTransferAttempted();

    address public forbiddenSender;

    constructor(
        string memory _name,
        string memory _symbol,
        uint8 _decimals
    ) TestToken(_name, _symbol, _decimals) {}

    function setForbiddenSender(address _forbiddenSender) external {
        forbiddenSender = _forbiddenSender;
    }

    function transfer(
        address to,
        uint256 amount
    ) public override returns (bool) {
        if (msg.sender == forbiddenSender) revert RefundTransferAttempted();
        return super.transfer(to, amount);
    }
}

contract MockSponsoredCctpSrcPeriphery is ISponsoredCCTPSrcPeriphery {
    function depositForBurn(
        SponsoredCCTPQuote calldata,
        bytes calldata
    ) external override {}
}

// Minimal stub facet (for Diamond addFacet)
contract TestAcrossV4SwapFacetRefundOrdering is
    AcrossV4SwapFacet,
    TestWhitelistManagerBase
{
    constructor(
        ISpokePoolPeriphery _spokePoolPeriphery,
        address _spokePool,
        address _sponsoredOftSrcPeriphery,
        address _sponsoredCctpSrcPeriphery,
        address _backendSigner
    )
        AcrossV4SwapFacet(
            _spokePoolPeriphery,
            _spokePool,
            _sponsoredOftSrcPeriphery,
            _sponsoredCctpSrcPeriphery,
            _backendSigner
        )
    {}
}

contract AcrossV4SwapFacetSponsoredRefundOrderingTest is Test, DiamondTest {
    address internal constant USER_SENDER = address(0xabc123456);
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER =
        0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;

    LiFiDiamond internal diamond;
    AcrossV4SwapFacet internal facet;

    TestToken internal dai;
    RevertingToken internal cctpToken;

    MockUniswapDEX internal dex;
    MockSponsoredCctpSrcPeriphery internal cctpPeriphery;

    function setUp() public {
        vm.deal(USER_SENDER, 10 ether);

        dai = new TestToken("DAI", "DAI", 18);
        cctpToken = new RevertingToken("CCTP", "CCTP", 6);

        dex = new MockUniswapDEX();
        cctpPeriphery = new MockSponsoredCctpSrcPeriphery();

        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
        cctpToken.setForbiddenSender(address(diamond));

        TestAcrossV4SwapFacetRefundOrdering facetImpl = new TestAcrossV4SwapFacetRefundOrdering(
                ISpokePoolPeriphery(address(0)),
                address(0xBEEF), // required non-zero
                address(0),
                address(cctpPeriphery),
                address(0xCAFE) // required non-zero
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

        facet = AcrossV4SwapFacet(address(diamond));

        // allow swapExactTokensForTokens on the mock DEX
        TestAcrossV4SwapFacetRefundOrdering(address(diamond))
            .addAllowedContractSelector(
                address(dex),
                MockUniswapDEX.swapExactTokensForTokens.selector
            );
    }

    function _swapDataDaiToToken(
        address outputToken,
        uint256 outputAmount
    ) internal view returns (LibSwap.SwapData[] memory swapData) {
        swapData = new LibSwap.SwapData[](1);

        address[] memory path = new address[](2);
        path[0] = address(dai);
        path[1] = outputToken;

        swapData[0] = LibSwap.SwapData({
            callTo: address(dex),
            approveTo: address(dex),
            sendingAssetId: address(dai),
            receivingAssetId: outputToken,
            fromAmount: 100e18,
            callData: abi.encodeWithSelector(
                MockUniswapDEX.swapExactTokensForTokens.selector,
                100e18,
                outputAmount,
                path,
                address(diamond),
                block.timestamp + 20 minutes
            ),
            requiresDeposit: true
        });
    }

    function testRevert_SponsoredCctp_PositiveSlippage_WhenDestinationDomainMismatch_RevertsInformationMismatchBeforeRefund()
        public
    {
        // Arrange a quote that will fail destinationDomain validation for chainId=999 (domain 19).
        ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote;
        quote.destinationDomain = 6; // mismatch (Base)
        quote.finalRecipient = bytes32(uint256(uint160(USER_RECEIVER)));
        quote.amount = 1_000_000; // 1.0 (6 decimals)
        quote.burnToken = bytes32(uint256(uint160(address(cctpToken))));

        // Positive slippage: swap outputs quotedAmount + 1.
        uint256 swapOutput = quote.amount + 1;
        LibSwap.SwapData[] memory swapData = _swapDataDaiToToken(
            address(cctpToken),
            swapOutput
        );

        // Fund user + dex.
        dai.mint(USER_SENDER, swapData[0].fromAmount);
        cctpToken.mint(address(dex), swapOutput);

        dex.setSwapOutput(
            swapData[0].fromAmount,
            ERC20(address(cctpToken)),
            swapOutput
        );

        ILiFi.BridgeData memory bridgeData = ILiFi.BridgeData({
            transactionId: "tx",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: address(cctpToken),
            receiver: USER_RECEIVER,
            minAmount: quote.amount,
            destinationChainId: 999,
            hasSourceSwaps: true,
            hasDestinationCall: false
        });

        AcrossV4SwapFacet.AcrossV4SwapFacetData memory facetData;
        facetData.swapApiTarget = AcrossV4SwapFacet
            .SwapApiTarget
            .SponsoredCCTPSrcPeriphery;
        facetData.callData = abi.encode(quote, bytes(""), USER_SENDER);
        facetData.signature = "";

        vm.startPrank(USER_SENDER);
        dai.approve(address(diamond), swapData[0].fromAmount);

        // Refund transfers use `LibAsset.transferERC20`, which would call `cctpToken.transfer` and revert
        // with RefundTransferAttempted() if executed before validation. We expect the validation revert instead.
        vm.expectRevert(InformationMismatch.selector);

        facet.swapAndStartBridgeTokensViaAcrossV4Swap(
            bridgeData,
            swapData,
            facetData
        );
        vm.stopPrank();
    }
}
