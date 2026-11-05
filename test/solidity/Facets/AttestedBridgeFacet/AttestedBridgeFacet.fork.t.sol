// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test, Vm } from "forge-std/Test.sol";
import { IERC20 } from "forge-std/interfaces/IERC20.sol";

import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";
import { LiFiIntentEscrowFacetV2 } from "lifi/Facets/LiFiIntentEscrowFacetV2.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { PolymerCCTPFacet } from "lifi/Facets/PolymerCCTPFacet.sol";
import { WhitelistManagerFacet } from "lifi/Facets/WhitelistManagerFacet.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { IERC173 } from "lifi/Interfaces/IERC173.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";

import { AttestedBridgeFacet } from "lifi/Facets/AttestedBridgeFacet.sol";
import { RecordingAttester } from "test/solidity/Facets/AttestedBridgeFacet/AttestedBridgeFacet.t.sol";
import { UniswapV2Router02 } from "test/solidity/utils/Interfaces.sol";

/// @dev Runs the gateway against the live Base Diamond and the three bridge facets it will
///      dispatch. The test contract is the gateway caller (the solver's executor).
contract AttestedBridgeFacetForkTest is Test {
    address internal constant LIFI_DIAMOND =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    uint256 internal constant BASE_FORK_BLOCK = 53_500_000;
    /// @dev The facet addresses below are from `deployments/base.diamond.json`
    address internal constant ACROSS_FACET_V4 =
        0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd;
    address internal constant POLYMER_CCTP_FACET =
        0x5E79e8C67CC7FEd03b283E84A5e16500f094B6b5;
    address internal constant LIFI_INTENT_ESCROW_FACET_V2 =
        0x0FC3045A569f55233BA26d92dB2e7DbB47C30D76;
    address internal constant PERIPHERY_REGISTRY_FACET =
        0xf1269030deB739edB0b7dABA9b701E102116d86c;
    /// @dev From `config/lifiintentescrow.json`
    address internal constant OIF_OUTPUT_SETTLER =
        0x75220B7600c300005038432a0000f308e0000068;
    address internal constant UNISWAP_V2_ROUTER =
        0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24;
    address internal constant USDC =
        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant OP_USDC =
        0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85;
    address internal constant OP_WETH =
        0x4200000000000000000000000000000000000006;
    string internal constant BRIDGE_ATTESTER_KEY = "BridgeAttester";
    bytes32 internal constant BRIDGE_ATTESTER_SLOT =
        0x2ea1c0530bb78d2f977ca48354f502a4489c9a6563d07a122a90ebb900c253fd;
    bytes32 internal constant LIFI_TRANSFER_STARTED =
        keccak256(
            "LiFiTransferStarted((bytes32,string,string,address,address,address,uint256,uint256,bool,bool))"
        );
    uint256 internal constant AMOUNT = 0.05 ether;
    uint256 internal constant USDC_AMOUNT = 100e6;
    /// @dev Native sent on top of the swap's quoted input, to be refunded
    uint256 internal constant EXCESS_NATIVE = 0.01 ether;
    uint256 internal constant OP_CHAIN_ID = 10;

    address internal diamondOwner;
    address internal spokePool;
    address internal wrappedNative;
    address internal receiver;
    address internal refundRecipient;
    address internal inputOracle;
    RecordingAttester internal attester;

    function setUp() public {
        vm.createSelectFork(
            vm.envString("ETH_NODE_URI_BASE"),
            BASE_FORK_BLOCK
        );
        assertGt(
            LIFI_DIAMOND.code.length,
            0,
            "no LiFiDiamond code at the fork block"
        );
        assertGt(
            UNISWAP_V2_ROUTER.code.length,
            0,
            "no Uniswap V2 router at the fork block"
        );
        diamondOwner = IERC173(LIFI_DIAMOND).owner();
        assertEq(
            IDiamondLoupe(LIFI_DIAMOND).facetAddress(
                AttestedBridgeFacet.startBridgeAttested.selector
            ),
            address(0)
        );

        bytes4[] memory bridgeSelectors = _bridgeSelectors();
        address[3] memory bridgeFacets = [
            ACROSS_FACET_V4,
            POLYMER_CCTP_FACET,
            LIFI_INTENT_ESCROW_FACET_V2
        ];
        for (uint256 i; i < bridgeSelectors.length; ++i) {
            assertEq(
                IDiamondLoupe(LIFI_DIAMOND).facetAddress(bridgeSelectors[i]),
                bridgeFacets[i / 2],
                "bridge selector not routed to the logged facet"
            );
        }
        spokePool = address(AcrossFacetV4(ACROSS_FACET_V4).SPOKEPOOL());
        wrappedNative = LibBytes.toAddress(
            AcrossFacetV4(ACROSS_FACET_V4).WRAPPED_NATIVE()
        );
        assertEq(PolymerCCTPFacet(POLYMER_CCTP_FACET).USDC(), USDC);

        bytes4[] memory gatewaySelectors = new bytes4[](3);
        gatewaySelectors[0] = AttestedBridgeFacet.startBridgeAttested.selector;
        gatewaySelectors[1] = AttestedBridgeFacet
            .setAttestableSelector
            .selector;
        gatewaySelectors[2] = AttestedBridgeFacet
            .isAttestableSelector
            .selector;
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        cut[0] = LibDiamond.FacetCut(
            address(new AttestedBridgeFacet()),
            LibDiamond.FacetCutAction.Add,
            gatewaySelectors
        );
        vm.startPrank(diamondOwner);

        IDiamondCut(LIFI_DIAMOND).diamondCut(cut, address(0), "");
        for (uint256 i; i < bridgeSelectors.length; ++i) {
            AttestedBridgeFacet(LIFI_DIAMOND).setAttestableSelector(
                bridgeSelectors[i],
                true
            );
        }
        WhitelistManagerFacet(LIFI_DIAMOND).setContractSelectorWhitelist(
            UNISWAP_V2_ROUTER,
            UniswapV2Router02.swapETHForExactTokens.selector,
            true
        );

        vm.stopPrank();

        for (uint256 i; i < bridgeSelectors.length; ++i) {
            assertTrue(
                AttestedBridgeFacet(LIFI_DIAMOND).isAttestableSelector(
                    bridgeSelectors[i]
                )
            );
        }
        receiver = makeAddr("receiver");
        refundRecipient = makeAddr("refundRecipient");
        inputOracle = makeAddr("inputOracle");
        attester = new RecordingAttester();
    }

    /// @dev The gateway caller receives refunds of excess native from AcrossV4
    receive() external payable {}

    function test_NativeAcrossV4DepositThroughTheGateway() public {
        _registerAttester(address(attester));
        (
            bytes memory call,
            ILiFi.BridgeData memory bridgeData
        ) = _acrossNativeCall();
        bytes memory attesterData = _attesterData();
        uint256 diamondBalanceBefore = LIFI_DIAMOND.balance;
        uint256 spokePoolWrappedBefore = IERC20(wrappedNative).balanceOf(
            spokePool
        );
        vm.deal(address(this), AMOUNT);
        vm.recordLogs();

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested{ value: AMOUNT }(
            call,
            attesterData
        );

        Vm.Log memory started = _onlyTransferStarted(vm.getRecordedLogs());
        ILiFi.BridgeData memory emitted = abi.decode(
            started.data,
            (ILiFi.BridgeData)
        );

        assertEq(started.emitter, LIFI_DIAMOND);
        assertEq(emitted.transactionId, bridgeData.transactionId);
        assertEq(emitted.minAmount, AMOUNT);
        assertEq(emitted.receiver, receiver);
        assertEq(
            IERC20(wrappedNative).balanceOf(spokePool) -
                spokePoolWrappedBefore,
            AMOUNT
        );
        assertEq(LIFI_DIAMOND.balance, diamondBalanceBefore);
        assertEq(address(this).balance, 0);
        _assertAttested(call, attesterData);
    }

    function test_Erc20AcrossV4DepositPullsFromTheCaller() public {
        _registerAttester(address(attester));
        ILiFi.BridgeData memory bridgeData = _bridgeData("across", USDC);
        bytes memory call = abi.encodeCall(
            AcrossFacetV4.startBridgeTokensViaAcrossV4,
            (bridgeData, _acrossData(USDC, OP_USDC, USDC_AMOUNT))
        );
        bytes memory attesterData = _attesterData();
        uint256 spokePoolBefore = IERC20(USDC).balanceOf(spokePool);
        _fundAndApproveUsdc();

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested(
            call,
            attesterData
        );

        assertEq(IERC20(USDC).balanceOf(address(this)), 0);
        assertEq(
            IERC20(USDC).balanceOf(spokePool) - spokePoolBefore,
            USDC_AMOUNT
        );
        _assertAttested(call, attesterData);
    }

    function test_SwapAndAcrossV4RefundsExcessNativeToTheCaller() public {
        _registerAttester(address(attester));
        (LibSwap.SwapData[] memory swaps, uint256 nativeIn) = _nativeToUsdc();
        ILiFi.BridgeData memory bridgeData = _bridgeData("across", USDC);
        bridgeData.hasSourceSwaps = true;
        bytes memory call = abi.encodeCall(
            AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4,
            (bridgeData, swaps, _acrossData(USDC, OP_USDC, USDC_AMOUNT))
        );
        bytes memory attesterData = _attesterData();
        uint256 spokePoolBefore = IERC20(USDC).balanceOf(spokePool);
        uint256 diamondBalanceBefore = LIFI_DIAMOND.balance;
        vm.deal(address(this), nativeIn + EXCESS_NATIVE);

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested{
            value: nativeIn + EXCESS_NATIVE
        }(call, attesterData);

        assertEq(address(this).balance, EXCESS_NATIVE);
        assertEq(LIFI_DIAMOND.balance, diamondBalanceBefore);
        assertEq(
            IERC20(USDC).balanceOf(spokePool) - spokePoolBefore,
            USDC_AMOUNT
        );
        _assertAttested(call, attesterData);
    }

    function test_Erc20PolymerCCTPBurnPullsFromTheCaller() public {
        _registerAttester(address(attester));
        ILiFi.BridgeData memory bridgeData = _bridgeData("polymer", USDC);
        PolymerCCTPFacet.PolymerCCTPData memory polymerData = _polymerData();
        bytes memory call = abi.encodeCall(
            PolymerCCTPFacet.startBridgeTokensViaPolymerCCTP,
            (bridgeData, polymerData)
        );
        bytes memory attesterData = _attesterData();
        address feeReceiver = PolymerCCTPFacet(POLYMER_CCTP_FACET)
            .POLYMER_FEE_RECEIVER();
        uint256 feeReceiverBefore = IERC20(USDC).balanceOf(feeReceiver);
        uint256 diamondUsdcBefore = IERC20(USDC).balanceOf(LIFI_DIAMOND);
        uint256 supplyBefore = IERC20(USDC).totalSupply();
        _fundAndApproveUsdc();

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested(
            call,
            attesterData
        );

        assertEq(IERC20(USDC).balanceOf(address(this)), 0);
        assertEq(
            IERC20(USDC).balanceOf(feeReceiver) - feeReceiverBefore,
            polymerData.polymerTokenFee
        );
        assertEq(
            supplyBefore - IERC20(USDC).totalSupply(),
            USDC_AMOUNT - polymerData.polymerTokenFee
        );
        assertEq(IERC20(USDC).balanceOf(LIFI_DIAMOND), diamondUsdcBefore);
        _assertAttested(call, attesterData);
    }

    function test_SwapAndPolymerCCTPRefundsExcessNativeToRefundRecipient()
        public
    {
        _registerAttester(address(attester));
        (LibSwap.SwapData[] memory swaps, uint256 nativeIn) = _nativeToUsdc();
        ILiFi.BridgeData memory bridgeData = _bridgeData("polymer", USDC);
        bridgeData.hasSourceSwaps = true;
        bytes memory call = abi.encodeCall(
            PolymerCCTPFacet.swapAndStartBridgeTokensViaPolymerCCTP,
            (bridgeData, swaps, _polymerData())
        );
        bytes memory attesterData = _attesterData();
        uint256 diamondBalanceBefore = LIFI_DIAMOND.balance;
        uint256 supplyBefore = IERC20(USDC).totalSupply();
        vm.deal(address(this), nativeIn + EXCESS_NATIVE);

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested{
            value: nativeIn + EXCESS_NATIVE
        }(call, attesterData);

        assertEq(refundRecipient.balance, EXCESS_NATIVE);
        assertEq(address(this).balance, 0);
        assertEq(LIFI_DIAMOND.balance, diamondBalanceBefore);
        assertEq(
            supplyBefore - IERC20(USDC).totalSupply(),
            USDC_AMOUNT - USDC_AMOUNT / 100
        );
        _assertAttested(call, attesterData);
    }

    function test_Erc20LiFiIntentEscrowV2OpenPullsFromTheCaller() public {
        _registerAttester(address(attester));
        ILiFi.BridgeData memory bridgeData = _bridgeData("lifiIntent", USDC);
        bytes memory call = abi.encodeCall(
            LiFiIntentEscrowFacetV2.startBridgeTokensViaLiFiIntentEscrowV2,
            (bridgeData, _escrowData())
        );
        bytes memory attesterData = _attesterData();
        address settler = LiFiIntentEscrowFacetV2(LIFI_INTENT_ESCROW_FACET_V2)
            .LIFI_INTENT_ESCROW_SETTLER_V2();
        uint256 settlerBefore = IERC20(USDC).balanceOf(settler);
        _fundAndApproveUsdc();

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested(
            call,
            attesterData
        );

        assertEq(IERC20(USDC).balanceOf(address(this)), 0);
        assertEq(IERC20(USDC).balanceOf(settler) - settlerBefore, USDC_AMOUNT);
        _assertAttested(call, attesterData);
    }

    function test_SwapAndLiFiIntentEscrowV2RefundsExcessNativeToRefundRecipient()
        public
    {
        _registerAttester(address(attester));
        (LibSwap.SwapData[] memory swaps, uint256 nativeIn) = _nativeToUsdc();
        ILiFi.BridgeData memory bridgeData = _bridgeData("lifiIntent", USDC);
        bridgeData.hasSourceSwaps = true;
        bytes memory call = abi.encodeCall(
            LiFiIntentEscrowFacetV2
                .swapAndStartBridgeTokensViaLiFiIntentEscrowV2,
            (bridgeData, swaps, _escrowData())
        );
        bytes memory attesterData = _attesterData();
        address settler = LiFiIntentEscrowFacetV2(LIFI_INTENT_ESCROW_FACET_V2)
            .LIFI_INTENT_ESCROW_SETTLER_V2();
        uint256 settlerBefore = IERC20(USDC).balanceOf(settler);
        uint256 diamondBalanceBefore = LIFI_DIAMOND.balance;
        vm.deal(address(this), nativeIn + EXCESS_NATIVE);

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested{
            value: nativeIn + EXCESS_NATIVE
        }(call, attesterData);

        assertEq(refundRecipient.balance, EXCESS_NATIVE);
        assertEq(address(this).balance, 0);
        assertEq(LIFI_DIAMOND.balance, diamondBalanceBefore);
        assertEq(IERC20(USDC).balanceOf(settler) - settlerBefore, USDC_AMOUNT);
        _assertAttested(call, attesterData);
    }

    function testRevert_UnregisteredAttesterBeforeDispatch() public {
        (bytes memory call, ) = _acrossNativeCall();
        bytes memory attesterData = _attesterData();
        uint256 spokePoolWrappedBefore = IERC20(wrappedNative).balanceOf(
            spokePool
        );
        vm.deal(address(this), AMOUNT);

        assertEq(
            PeripheryRegistryFacet(LIFI_DIAMOND).getPeripheryContract(
                BRIDGE_ATTESTER_KEY
            ),
            address(0)
        );

        vm.recordLogs();
        vm.expectRevert(AttestedBridgeFacet.AttesterNotRegistered.selector);

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested{ value: AMOUNT }(
            call,
            attesterData
        );

        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(
            IERC20(wrappedNative).balanceOf(spokePool),
            spokePoolWrappedBefore
        );
        assertEq(address(this).balance, AMOUNT);

        _registerAttester(address(attester));

        AttestedBridgeFacet(LIFI_DIAMOND).startBridgeAttested{ value: AMOUNT }(
            call,
            attesterData
        );

        assertEq(attester.calls(), 1);
        assertEq(
            IERC20(wrappedNative).balanceOf(spokePool) -
                spokePoolWrappedBefore,
            AMOUNT
        );
    }

    function test_LiveRegistryWritesTheSlotTheGatewayReads() public {
        assertEq(
            IDiamondLoupe(LIFI_DIAMOND).facetAddress(
                PeripheryRegistryFacet.registerPeripheryContract.selector
            ),
            PERIPHERY_REGISTRY_FACET
        );
        assertEq(
            keccak256(
                abi.encodePacked(
                    BRIDGE_ATTESTER_KEY,
                    keccak256("com.lifi.facets.periphery_registry")
                )
            ),
            BRIDGE_ATTESTER_SLOT
        );
        assertEq(vm.load(LIFI_DIAMOND, BRIDGE_ATTESTER_SLOT), bytes32(0));

        _registerAttester(address(attester));

        assertEq(
            vm.load(LIFI_DIAMOND, BRIDGE_ATTESTER_SLOT),
            LibBytes.toBytes32(address(attester))
        );
    }

    function _registerAttester(address _attester) internal {
        vm.prank(diamondOwner);
        PeripheryRegistryFacet(LIFI_DIAMOND).registerPeripheryContract(
            BRIDGE_ATTESTER_KEY,
            _attester
        );
    }

    /// @dev Start and swap selector for each bridge facet, in `setUp`'s facet order
    function _bridgeSelectors()
        internal
        pure
        returns (bytes4[] memory selectors)
    {
        selectors = new bytes4[](6);
        selectors[0] = AcrossFacetV4.startBridgeTokensViaAcrossV4.selector;
        selectors[1] = AcrossFacetV4
            .swapAndStartBridgeTokensViaAcrossV4
            .selector;
        selectors[2] = PolymerCCTPFacet
            .startBridgeTokensViaPolymerCCTP
            .selector;
        selectors[3] = PolymerCCTPFacet
            .swapAndStartBridgeTokensViaPolymerCCTP
            .selector;
        selectors[4] = LiFiIntentEscrowFacetV2
            .startBridgeTokensViaLiFiIntentEscrowV2
            .selector;
        selectors[5] = LiFiIntentEscrowFacetV2
            .swapAndStartBridgeTokensViaLiFiIntentEscrowV2
            .selector;
    }

    function _bridgeData(
        string memory _bridge,
        address _sendingAssetId
    ) internal view returns (ILiFi.BridgeData memory) {
        return
            ILiFi.BridgeData({
                transactionId: keccak256(bytes(_bridge)),
                bridge: _bridge,
                integrator: "test-integrator",
                referrer: address(0),
                sendingAssetId: _sendingAssetId,
                receiver: receiver,
                minAmount: _sendingAssetId == address(0)
                    ? AMOUNT
                    : USDC_AMOUNT,
                destinationChainId: OP_CHAIN_ID,
                hasSourceSwaps: false,
                hasDestinationCall: false
            });
    }

    function _acrossData(
        address _sendingAssetId,
        address _receivingAssetId,
        uint256 _amount
    ) internal view returns (AcrossFacetV4.AcrossV4Data memory) {
        return
            AcrossFacetV4.AcrossV4Data({
                receiverAddress: LibBytes.toBytes32(receiver),
                refundAddress: LibBytes.toBytes32(receiver),
                sendingAssetId: LibBytes.toBytes32(_sendingAssetId),
                receivingAssetId: LibBytes.toBytes32(_receivingAssetId),
                outputAmount: (_amount * 99) / 100,
                outputAmountMultiplier: 0.99e18,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 1 hours),
                exclusivityParameter: 0,
                message: ""
            });
    }

    function _acrossNativeCall()
        internal
        view
        returns (bytes memory call, ILiFi.BridgeData memory bridgeData)
    {
        bridgeData = _bridgeData("across", address(0));
        call = abi.encodeCall(
            AcrossFacetV4.startBridgeTokensViaAcrossV4,
            (bridgeData, _acrossData(address(0), OP_WETH, AMOUNT))
        );
    }

    function _polymerData()
        internal
        view
        returns (PolymerCCTPFacet.PolymerCCTPData memory)
    {
        return
            PolymerCCTPFacet.PolymerCCTPData({
                polymerTokenFee: USDC_AMOUNT / 100,
                maxCCTPFee: USDC_AMOUNT / 10,
                nonEVMReceiver: bytes32(0),
                solanaReceiverATA: bytes32(0),
                minFinalityThreshold: 2000,
                refundRecipient: refundRecipient,
                hookData: ""
            });
    }

    function _escrowData()
        internal
        view
        returns (LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2 memory)
    {
        return
            LiFiIntentEscrowFacetV2.LiFiIntentEscrowDataV2({
                dstCallReceiver: bytes32(0),
                recipient: LibBytes.toBytes32(receiver),
                depositAndRefundAddress: refundRecipient,
                nonce: uint256(keccak256("attested-bridge-facet-fork")),
                expires: 1 days,
                fillDeadline: 1 hours,
                inputOracle: inputOracle,
                outputOracle: bytes32(0),
                outputSettler: LibBytes.toBytes32(OIF_OUTPUT_SETTLER),
                outputToken: LibBytes.toBytes32(OP_USDC),
                outputAmountMultiplier: 1e18,
                dstCallSwapData: new LibSwap.SwapData[](0),
                outputContext: ""
            });
    }

    /// @dev A native → USDC swap on the live Uniswap V2 router for exactly `USDC_AMOUNT`.
    ///      The router returns unspent native to the Diamond, which the facet refunds.
    function _nativeToUsdc()
        internal
        view
        returns (LibSwap.SwapData[] memory swaps, uint256 nativeIn)
    {
        address[] memory path = new address[](2);
        path[0] = wrappedNative;
        path[1] = USDC;
        nativeIn = UniswapV2Router02(UNISWAP_V2_ROUTER).getAmountsIn(
            USDC_AMOUNT,
            path
        )[0];
        swaps = new LibSwap.SwapData[](1);
        swaps[0] = LibSwap.SwapData({
            callTo: UNISWAP_V2_ROUTER,
            approveTo: UNISWAP_V2_ROUTER,
            sendingAssetId: address(0),
            receivingAssetId: USDC,
            fromAmount: nativeIn + EXCESS_NATIVE,
            callData: abi.encodeCall(
                UniswapV2Router02.swapETHForExactTokens,
                (USDC_AMOUNT, path, LIFI_DIAMOND, block.timestamp + 20 minutes)
            ),
            requiresDeposit: true
        });
    }

    function _fundAndApproveUsdc() internal {
        deal(USDC, address(this), USDC_AMOUNT);
        IERC20(USDC).approve(LIFI_DIAMOND, USDC_AMOUNT);
    }

    function _assertAttested(
        bytes memory _call,
        bytes memory _attesterData
    ) internal view {
        assertEq(attester.calls(), 1);
        assertEq(attester.lastCaller(), LIFI_DIAMOND);
        assertEq(attester.lastFacetCalldata(), _call);
        assertEq(attester.lastAttesterData(), _attesterData);
        assertEq(address(attester).balance, 0);
    }

    function _attesterData() internal pure returns (bytes memory data) {
        for (uint256 i; i < 16; ++i) {
            data = bytes.concat(data, keccak256(abi.encode(i)));
        }
    }

    function _onlyTransferStarted(
        Vm.Log[] memory _logs
    ) internal pure returns (Vm.Log memory started) {
        uint256 found;
        for (uint256 i; i < _logs.length; ++i) {
            if (
                _logs[i].topics.length != 0 &&
                _logs[i].topics[0] == LIFI_TRANSFER_STARTED
            ) {
                started = _logs[i];
                ++found;
            }
        }
        assertEq(found, 1, "expected exactly one LiFiTransferStarted");
    }
}
