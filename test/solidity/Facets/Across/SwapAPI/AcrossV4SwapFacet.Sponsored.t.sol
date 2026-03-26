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
    // - Sponsored CCTP depositForBurn: https://arbiscan.io/tx/0x4fb708325884739c1e22614b758e8baa31f8b6e6ea788d361638e98449105ccc
    // - Sponsored OFT deposit: https://arbiscan.io/tx/0xc2fae15f28177057b021ba6cb1f992420d47cdb77d3833789dbba835dc72f269
    bytes internal constant SPONSORED_CCTP_CALLDATA =
        hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002a000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000013000000000000000000000000478d451e101be484880a14cf3ccc293cd48e61400000000000000000000000000000000000000000000000000000000005d6ea8d000000000000000000000000af88d065e77c8cc2239327c5edb3a432268e5831000000000000000000000000478d451e101be484880a14cf3ccc293cd48e614000000000000000000000000000000000000000000000000000000000000031c100000000000000000000000000000000000000000000000000000000000003e82d22a8061c2e15ba06891704dafd0eb65a468a8d44e9ac5f001fff2ceaea301f0000000000000000000000000000000000000000000000000000000069c4f6e8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f4000000000000000000000000ce91663bf5b7d8c423d10b34555394ed54a7d8be000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004109e648b3f497ab857d440356d921b9ed7be091e77bbf96cb7b1bf5c97aaea079731f7657efa8dbe3cd5f58c6afe07ee4d266245589ffd2b17e5b08fe931fa9d41b000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";
    bytes internal constant SPONSORED_OFT_CALLDATA =
        hex"000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000002c000000000000000000000000000000000000000000000000000000000000000400000000000000000000000009a8f92a830a5cb89a3816e3d267cb7791c16b04d000000000000000000000000000000000000000000000000000000000000759e000000000000000000000000000000000000000000000000000000000000769f0000000000000000000000000ca8316a6fcc15c833a220c40d84550b0833943800000000000000000000000000000000000000000000000000000000000f42400e2fd0a7e9cad4c6a5455041b8fcc545f190a17604c4e7c1f70227a7b7da1aeb0000000000000000000000000000000000000000000000000000000069c44e73000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001f40000000000000000000000009a8f92a830a5cb89a3816e3d267cb7791c16b04d000000000000000000000000b88339cb7199b77e23db6e890353e22632ba630f0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002ab9800000000000000000000000000000000000000000000000000000000000493e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000220000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000416b0a8d27a220885480a8634c001d2e1d260558429f76e71d651b06600253ce73224ed0ddb3386e309d85c84f02c82ab9aa8a11d521598b1555bd732f51472faa1b000000000000000000000000000000000000000000000000000000000000001dc0de007f73c0de";

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
        // Fork before both fixture txs (OFT @ 445622005, CCTP @ 445794801) so quote nonces are unused.
        // Historical state requires an archive-capable `ETH_NODE_URI_ARBITRUM`.
        vm.createSelectFork(vm.envString("ETH_NODE_URI_ARBITRUM"), 445622003);

        usdc = ERC20(USDC_ARBITRUM);
        usdt = ERC20(USDT_ARBITRUM);

        // Ensure the test user can send value when needed.
        vm.deal(USER_SENDER, 10 ether);

        spokePoolPeriphery = _configAddress(
            "across.json",
            ".arbitrum.spokePoolPeriphery"
        );
        spokePool = _configAddress("across.json", ".arbitrum.acrossSpokePool");
        sponsoredOftSrcPeriphery = _configAddress(
            "across.json",
            ".arbitrum.sponsoredOftSrcPeriphery"
        );
        sponsoredCctpSrcPeriphery = _configAddress(
            "across.json",
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

        // ERC20 Transfer/Approval logs precede LiFiTransferStarted; only assert emitter + event type.
        vm.expectEmit(false, false, false, false, address(acrossV4SwapFacet));
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

        vm.expectEmit(false, false, false, false, address(acrossV4SwapFacet));
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
            destinationChainId: 999,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        uint256 senderBalBefore = usdt.balanceOf(USER_SENDER);

        vm.startPrank(USER_SENDER);
        usdt.approve(address(acrossV4SwapFacet), amount);

        vm.expectEmit(false, false, false, false, address(acrossV4SwapFacet));
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
            destinationChainId: 999,
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
            destinationChainId: 999,
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
