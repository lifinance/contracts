// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test, Vm } from "forge-std/Test.sol";
import { IERC20 } from "forge-std/interfaces/IERC20.sol";

import { AcrossFacetV4 } from "lifi/Facets/AcrossFacetV4.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { IERC173 } from "lifi/Interfaces/IERC173.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

import { AttestedBridgeFacet } from "lifi/Facets/AttestedBridgeFacet.sol";
import { RecordingAttester } from "./AttestedBridgeFacet.t.sol";

contract AttestedBridgeFacetForkTest is Test {
    address internal constant LIFI_DIAMOND =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    uint256 internal constant BASE_FORK_BLOCK = 51_738_000;
    /// @dev From `deployments/base.diamond.json`, version 1.0.0
    address internal constant ACROSS_FACET_V4 =
        0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd;
    string internal constant BRIDGE_ATTESTER_KEY = "BridgeAttester";
    bytes32 internal constant LIFI_TRANSFER_STARTED =
        keccak256(
            "LiFiTransferStarted((bytes32,string,string,address,address,address,uint256,uint256,bool,bool))"
        );
    uint256 internal constant AMOUNT = 0.05 ether;
    uint256 internal constant OP_CHAIN_ID = 10;
    address internal constant OP_WETH =
        0x4200000000000000000000000000000000000006;

    address internal diamondOwner;
    address internal spokePool;
    address internal wrappedNative;
    address internal receiver;

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
        diamondOwner = IERC173(LIFI_DIAMOND).owner();

        bytes4 acrossSelector = AcrossFacetV4
            .startBridgeTokensViaAcrossV4
            .selector;
        assertEq(
            IDiamondLoupe(LIFI_DIAMOND).facetAddress(acrossSelector),
            ACROSS_FACET_V4
        );
        assertEq(
            IDiamondLoupe(LIFI_DIAMOND).facetAddress(
                AttestedBridgeFacet.startBridgeAttested.selector
            ),
            address(0)
        );
        spokePool = address(AcrossFacetV4(ACROSS_FACET_V4).SPOKEPOOL());
        wrappedNative = address(
            uint160(uint256(AcrossFacetV4(ACROSS_FACET_V4).WRAPPED_NATIVE()))
        );

        bytes4[] memory selectors = new bytes4[](3);
        selectors[0] = AttestedBridgeFacet.startBridgeAttested.selector;
        selectors[1] = AttestedBridgeFacet.setAttestableSelector.selector;
        selectors[2] = AttestedBridgeFacet.isAttestableSelector.selector;
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        cut[0] = LibDiamond.FacetCut(
            address(new AttestedBridgeFacet()),
            LibDiamond.FacetCutAction.Add,
            selectors
        );
        vm.startPrank(diamondOwner);

        IDiamondCut(LIFI_DIAMOND).diamondCut(cut, address(0), "");
        AttestedBridgeFacet(LIFI_DIAMOND).setAttestableSelector(
            acrossSelector,
            true
        );

        vm.stopPrank();

        assertTrue(
            AttestedBridgeFacet(LIFI_DIAMOND).isAttestableSelector(
                acrossSelector
            )
        );
        receiver = makeAddr("receiver");
    }

    function test_NativeAcrossV4DepositThroughTheGateway() public {
        RecordingAttester attester = new RecordingAttester();
        _registerAttester(address(attester));
        (
            bytes memory call,
            ILiFi.BridgeData memory bridgeData
        ) = _acrossCall();
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
        assertEq(address(attester).balance, 0);
        assertEq(attester.calls(), 1);
        assertEq(attester.lastCaller(), LIFI_DIAMOND);
        assertEq(attester.lastFacetCalldata(), call);
        assertEq(attester.lastAttesterData(), attesterData);
    }

    function testRevert_UnregisteredAttesterBeforeDispatch() public {
        (bytes memory call, ) = _acrossCall();
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

        RecordingAttester attester = new RecordingAttester();
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

    function _registerAttester(address _attester) internal {
        vm.prank(diamondOwner);
        PeripheryRegistryFacet(LIFI_DIAMOND).registerPeripheryContract(
            BRIDGE_ATTESTER_KEY,
            _attester
        );
    }

    function _acrossCall()
        internal
        view
        returns (bytes memory call, ILiFi.BridgeData memory bridgeData)
    {
        bridgeData = ILiFi.BridgeData({
            transactionId: keccak256("attested-bridge-facet-fork"),
            bridge: "across",
            integrator: "test-integrator",
            referrer: address(0),
            sendingAssetId: address(0),
            receiver: receiver,
            minAmount: AMOUNT,
            destinationChainId: OP_CHAIN_ID,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });
        AcrossFacetV4.AcrossV4Data memory acrossData = AcrossFacetV4
            .AcrossV4Data({
                receiverAddress: bytes32(uint256(uint160(receiver))),
                refundAddress: bytes32(uint256(uint160(receiver))),
                sendingAssetId: bytes32(0),
                receivingAssetId: bytes32(uint256(uint160(OP_WETH))),
                outputAmount: (AMOUNT * 99) / 100,
                outputAmountMultiplier: 1e18,
                exclusiveRelayer: bytes32(0),
                quoteTimestamp: uint32(block.timestamp),
                fillDeadline: uint32(block.timestamp + 1 hours),
                exclusivityParameter: 0,
                message: ""
            });
        call = abi.encodeWithSelector(
            AcrossFacetV4.startBridgeTokensViaAcrossV4.selector,
            bridgeData,
            acrossData
        );
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
