// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondTest } from "../../../utils/DiamondTest.sol";
import { TestWhitelistManagerBase } from "../../../utils/TestWhitelistManagerBase.sol";
import { AcrossV4SwapFacet } from "lifi/Facets/AcrossV4SwapFacet.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { ISpokePoolPeriphery } from "lifi/Interfaces/ISpokePoolPeriphery.sol";
import { ISponsoredOFTSrcPeriphery } from "lifi/Interfaces/ISponsoredOFTSrcPeriphery.sol";
import { ISponsoredCCTPSrcPeriphery } from "lifi/Interfaces/ISponsoredCCTPSrcPeriphery.sol";
import { InformationMismatch, InvalidCallData, InvalidReceiver } from "lifi/Errors/GenericErrors.sol";

using stdJson for string;

// Minimal stub facet (for Diamond addFacet)
contract TestAcrossV4SwapFacetSponsored is
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

/// @notice Sponsored-flow focused tests for AcrossV4SwapFacet
/// @dev Split out to isolate stack-too-deep compilation issues in legacy pipeline
contract AcrossV4SwapFacetSponsoredTest is Test, DiamondTest, ILiFi {
    // Arbitrum token addresses (USDC.e on Arbitrum One)
    address internal constant USDC_ARBITRUM =
        0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant USDT_ARBITRUM =
        0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    // Accounts (mirrors TestBase)
    address internal constant USER_SENDER = address(0xabc123456);
    address internal constant USER_RECEIVER = address(0xabc654321);
    address internal constant USER_PAUSER = address(0xdeadbeef);
    address internal constant USER_DIAMOND_OWNER =
        0x5042255A3F3FD7727e419CeA387cAFDfad3C3aF8;

    // Across periphery callData (no selector), sourced from real Arbitrum transactions:
    // - Sponsored CCTP depositForBurn: `0x58e7603e5e442ddc33f8cc78f20ca1193519589a5085b0233ed5ab069afcfbc5`
    // - Sponsored OFT deposit: `0xebb4c5303972f84ac9bff42a106f23fe04773bee0119f6521f3a0fae8db60edb`
    bytes internal constant SPONSORED_CCTP_CALLDATA =
        hex"00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000130000000000000000000000001c709fd0db6a6b877ddb19ae3d485b7b4add879f000000000000000000000000000000000000000000000000000000040e225440000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e58310000000000000000000000001c709fd0db6a6b877ddb19ae3d485b7b4add879f0000000000000000000000000000000000000000000000000000000000228c9200000000000000000000000000000000000000000000000000000000000003e88c29807243f39dc62a658288c3da78b0f9f0491128a6d4ad8c6fb180000cd1440000000000000000000000000000000000000000000000000000000069681798000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000f961e5e6c5276164adb2865b7e80cf82dc04e920000000000000000000000000111111a1a0667d36bd57c0a9f569b98057111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004146c1b04bb28d876845ad77693b8854efcbae821becd2f3ee69ce7c1c99af34f75f2787bd8e94c33d2a779b3868a2f17acb4b11b8842a4561c8115471c7800d371b000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";
    bytes internal constant SPONSORED_OFT_CALLDATA =
        hex"00000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000260000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000064000000000000000000000000000000000000000000000000000000000000759e000000000000000000000000000000000000000000000000000000000000769f000000000000000000000000c8786d517b4e224bb43985a38dbef8588d7354cd00000000000000000000000000000000000000000000000000000000004c4b40d68523e6dfa620bda28fce2092480828305416d2b5b091b9560985325e699570000000000000000000000000000000000000000000000000000000006967c89000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000404dc936b5ce2f01cd80ede9cd4e5809a483d32000000000000000000000000b8ce59fc3717ada4c02eadf9682a9e934f625ebb000000000000000000000000000000000000000000000000000000000002ab9800000000000000000000000000000000000000000000000000000000000493e0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000411442fc1a5c7c2df5cbc0ff83364521cf33be93aea0e0881b4a1009bae8aba16d50ba7f74ba7605f0e4463af5fd7a129c60595baccca434b0ca4b07be626b2f6f1c000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";

    LiFiDiamond internal diamond;
    AcrossV4SwapFacet internal acrossV4SwapFacet;
    ERC20 internal usdc;
    ERC20 internal usdt;

    address internal spokePoolPeriphery;
    address internal spokePool;
    address internal sponsoredOftSrcPeriphery;
    address internal sponsoredCctpSrcPeriphery;
    address internal backendSigner;

    function setUp() public {
        // Fork Arbitrum at (or before) both provided txs.
        vm.createSelectFork(vm.envString("ETH_NODE_URI_ARBITRUM"), 421327371);

        usdc = ERC20(USDC_ARBITRUM);
        usdt = ERC20(USDT_ARBITRUM);

        // Ensure the test user can send value when needed.
        vm.deal(USER_SENDER, 10 ether);

        spokePoolPeriphery = _configAddress(
            "acrossV4Swap.json",
            ".arbitrum.spokePoolPeriphery"
        );
        spokePool = _configAddress("acrossV4Swap.json", ".arbitrum.spokePool");
        sponsoredOftSrcPeriphery = _configAddress(
            "acrossV4Swap.json",
            ".arbitrum.sponsoredOftSrcPeriphery"
        );
        sponsoredCctpSrcPeriphery = _configAddress(
            "acrossV4Swap.json",
            ".arbitrum.sponsoredCctpSrcPeriphery"
        );

        backendSigner = vm.addr(0xA11CE);

        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);

        TestAcrossV4SwapFacetSponsored facetImpl = new TestAcrossV4SwapFacetSponsored(
                ISpokePoolPeriphery(spokePoolPeriphery),
                spokePool,
                sponsoredOftSrcPeriphery,
                sponsoredCctpSrcPeriphery,
                backendSigner
            );

        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = facetImpl
            .startBridgeTokensViaAcrossV4Swap
            .selector;
        functionSelectors[1] = facetImpl
            .swapAndStartBridgeTokensViaAcrossV4Swap
            .selector;
        addFacet(diamond, address(facetImpl), functionSelectors);

        acrossV4SwapFacet = AcrossV4SwapFacet(address(diamond));

        vm.label(address(diamond), "LiFiDiamond");
        vm.label(address(acrossV4SwapFacet), "AcrossV4SwapFacet");
        vm.label(spokePoolPeriphery, "SpokePoolPeriphery");
        vm.label(spokePool, "SpokePool");
        vm.label(sponsoredOftSrcPeriphery, "SponsoredOftSrcPeriphery");
        vm.label(sponsoredCctpSrcPeriphery, "SponsoredCctpSrcPeriphery");
        vm.label(USER_SENDER, "USER_SENDER");
        vm.label(USER_RECEIVER, "USER_RECEIVER");
    }

    function _configAddress(
        string memory configFileName,
        string memory jsonPath
    ) internal returns (address) {
        string memory path = string.concat(
            vm.projectRoot(),
            "/config/",
            configFileName
        );
        string memory json = vm.readFile(path);
        return json.readAddress(jsonPath);
    }

    function test_CanBridgeViaSponsoredCctp_RealPeriphery_RealCalldata()
        public
    {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_CCTP_CALLDATA,
                (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
            );

        // Domain 19 maps to chainId 999 (HyperEVM) in `_chainIdToCctpDomainId`.
        assertEq(uint256(quote.destinationDomain), 19);

        address burnToken = address(uint160(uint256(quote.burnToken)));
        assertEq(burnToken, USDC_ARBITRUM);

        uint256 amount = quote.amount;

        deal(USDC_ARBITRUM, USER_SENDER, amount);

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: burnToken,
            receiver: address(uint160(uint256(quote.finalRecipient))),
            minAmount: amount,
            destinationChainId: 999,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        uint256 senderBalBefore = usdc.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), amount);

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(localBridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, signature, USER_SENDER),
                signature: ""
            })
        );
        vm.stopPrank();

        assertEq(usdc.balanceOf(USER_SENDER), senderBalBefore - amount);
    }

    function test_CanBridgeViaSponsoredCctp_RealPeriphery_RealCalldata_HyperCoreChainId()
        public
    {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_CCTP_CALLDATA,
                (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
            );

        // Domain 19 maps to chainId 1337 (HyperCore via HyperEVM) in `_chainIdToCctpDomainId`.
        assertEq(uint256(quote.destinationDomain), 19);

        address burnToken = address(uint160(uint256(quote.burnToken)));
        assertEq(burnToken, USDC_ARBITRUM);

        uint256 amount = quote.amount;

        deal(USDC_ARBITRUM, USER_SENDER, amount);

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: burnToken,
            receiver: address(uint160(uint256(quote.finalRecipient))),
            minAmount: amount,
            destinationChainId: 1337,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        uint256 senderBalBefore = usdc.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), amount);

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(localBridgeData);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, signature, USER_SENDER),
                signature: ""
            })
        );
        vm.stopPrank();

        assertEq(usdc.balanceOf(USER_SENDER), senderBalBefore - amount);
    }

    function test_CanBridgeViaSponsoredOft_RealPeriphery_RealCalldata()
        public
    {
        (
            ISponsoredOFTSrcPeriphery.Quote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_OFT_CALLDATA,
                (ISponsoredOFTSrcPeriphery.Quote, bytes)
            );

        // The stored callData may contain an unset refund recipient (unsigned param).
        // Set it here so the facet's safety validation passes.
        quote.unsignedParams.refundRecipient = USER_SENDER;

        uint256 amount = quote.signedParams.amountLD;

        // This real tx transferred USDT on Arbitrum into the Sponsored OFT periphery.
        deal(USDT_ARBITRUM, USER_SENDER, amount);

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDT_ARBITRUM,
            receiver: address(
                uint160(uint256(quote.signedParams.finalRecipient))
            ),
            minAmount: amount,
            destinationChainId: 1,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        uint256 senderBalBefore = usdt.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        usdt.approve(address(acrossV4SwapFacet), amount);

        vm.expectEmit(true, true, true, true, address(acrossV4SwapFacet));
        emit LiFiTransferStarted(localBridgeData);

        // Sponsored OFT deposits are payable (LayerZero messaging fees).
        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap{
            value: 0.01 ether
        }(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: abi.encode(quote, signature),
                signature: ""
            })
        );
        vm.stopPrank();

        assertEq(usdt.balanceOf(USER_SENDER), senderBalBefore - amount);
    }

    function testRevert_SponsoredOft_WhenRefundRecipientZero() public {
        (
            ISponsoredOFTSrcPeriphery.Quote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_OFT_CALLDATA,
                (ISponsoredOFTSrcPeriphery.Quote, bytes)
            );

        quote.unsignedParams.refundRecipient = address(0);

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDT_ARBITRUM,
            receiver: address(
                uint160(uint256(quote.signedParams.finalRecipient))
            ),
            minAmount: quote.signedParams.amountLD,
            destinationChainId: 1,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        deal(USDT_ARBITRUM, USER_SENDER, localBridgeData.minAmount);
        vm.startPrank(USER_SENDER);
        usdt.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredOFTSrcPeriphery,
                callData: abi.encode(quote, signature),
                signature: ""
            })
        );
        vm.stopPrank();
    }

    function testRevert_SponsoredOft_WhenNativeAsset() public {
        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: address(0),
            receiver: USER_RECEIVER,
            minAmount: 1 ether,
            destinationChainId: 1,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

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
                callData: SPONSORED_OFT_CALLDATA,
                signature: ""
            })
        );
        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenMsgValueNonZero() public {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_CCTP_CALLDATA,
                (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
            );

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ARBITRUM,
            receiver: address(uint160(uint256(quote.finalRecipient))),
            minAmount: quote.amount,
            destinationChainId: 999,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        deal(USDC_ARBITRUM, USER_SENDER, localBridgeData.minAmount);
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap{ value: 1 }(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, signature, USER_SENDER),
                signature: ""
            })
        );
        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenBurnTokenMismatch() public {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_CCTP_CALLDATA,
                (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
            );

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDT_ARBITRUM,
            receiver: address(uint160(uint256(quote.finalRecipient))),
            minAmount: quote.amount,
            destinationChainId: 999,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        deal(USDT_ARBITRUM, USER_SENDER, localBridgeData.minAmount);
        vm.startPrank(USER_SENDER);
        usdt.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, signature, USER_SENDER),
                signature: ""
            })
        );
        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenDestinationDomainMismatch() public {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_CCTP_CALLDATA,
                (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
            );

        // Force a mismatch against chainId=999 (domain 19) while keeping signature bytes (will revert before signature is used).
        quote.destinationDomain = 6;

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ARBITRUM,
            receiver: address(uint160(uint256(quote.finalRecipient))),
            minAmount: quote.amount,
            destinationChainId: 999,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        deal(USDC_ARBITRUM, USER_SENDER, localBridgeData.minAmount);
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InformationMismatch.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, signature, USER_SENDER),
                signature: ""
            })
        );
        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenChainIdNotMapped() public {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_CCTP_CALLDATA,
                (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
            );

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ARBITRUM,
            receiver: address(uint160(uint256(quote.finalRecipient))),
            minAmount: quote.amount,
            destinationChainId: 9999999,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        deal(USDC_ARBITRUM, USER_SENDER, localBridgeData.minAmount);
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InvalidCallData.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, signature, USER_SENDER),
                signature: ""
            })
        );
        vm.stopPrank();
    }

    function testRevert_SponsoredCctp_WhenReceiverMismatch() public {
        (
            ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote memory quote,
            bytes memory signature
        ) = abi.decode(
                SPONSORED_CCTP_CALLDATA,
                (ISponsoredCCTPSrcPeriphery.SponsoredCCTPQuote, bytes)
            );

        ILiFi.BridgeData memory localBridgeData = ILiFi.BridgeData({
            transactionId: "someId",
            bridge: "acrossV4Swap",
            integrator: "",
            referrer: address(0),
            sendingAssetId: USDC_ARBITRUM,
            receiver: address(0xdead),
            minAmount: quote.amount,
            destinationChainId: 999,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        deal(USDC_ARBITRUM, USER_SENDER, localBridgeData.minAmount);
        vm.startPrank(USER_SENDER);
        usdc.approve(address(acrossV4SwapFacet), localBridgeData.minAmount);

        vm.expectRevert(InvalidReceiver.selector);

        acrossV4SwapFacet.startBridgeTokensViaAcrossV4Swap(
            localBridgeData,
            AcrossV4SwapFacet.AcrossV4SwapFacetData({
                swapApiTarget: AcrossV4SwapFacet
                    .SwapApiTarget
                    .SponsoredCCTPSrcPeriphery,
                callData: abi.encode(quote, signature, USER_SENDER),
                signature: ""
            })
        );
        vm.stopPrank();
    }
}
