// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { stdJson } from "forge-std/StdJson.sol";

import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { RelayFacet } from "lifi/Facets/RelayFacet.sol";

interface IConsumeFacet {
    function consume(bytes32 id) external;
}

/// @dev Minimal legacy-writer facet: its first storage variable is a mapping at slot 0.
///      When called via the diamond, this writes to the diamond's legacy slot-0 mapping layout.
///
/// Why not "just call RelayFacet to consume" like `RelayFacet.t.sol`?
/// - On the deployed mainnet facet, `startBridgeTokensViaRelay` is gated by a solver signature.
/// - The solver is an immutable address and we do not have its private key on a fork, so we cannot
///   produce a signature that passes validation to exercise the write-path.
/// This facet gives us a deterministic, on-chain-execution (delegatecall) way to populate the
/// legacy mapping before upgrading RelayFacet.
contract LegacyConsumedIdsFacet {
    mapping(bytes32 => bool) public consumedIds;

    function consume(bytes32 id) external {
        consumedIds[id] = true;
    }
}

/// @notice Fork test that uses the deployed mainnet diamond and validates replay protection
///         across upgrading RelayFacet from legacy slot-0 mapping to namespaced storage.
contract RelayFacetForkUpgradeReplayProtectionTest is Test {
    using stdJson for string;

    bytes32 internal constant BOOL_TRUE_WORD = bytes32(uint256(1));

    address internal lifiDiamond;
    address internal deployedRelayFacet;

    function setUp() public {
        // Fork mainnet at a pinned block for deterministic results.
        vm.createSelectFork(vm.envString("ETH_NODE_URI_MAINNET"), 24165936);

        string memory deploymentsJson = vm.readFile(
            string.concat(vm.projectRoot(), "/deployments/mainnet.json")
        );

        lifiDiamond = deploymentsJson.readAddress(".LiFiDiamond");
        deployedRelayFacet = deploymentsJson.readAddress(".RelayFacet");
    }

    function test_ReplayProtectionPersistsAcrossRelayFacetUpgrade() public {
        // Sanity: ensure the deployed diamond currently routes the selector to the old version of RelayFacet
        address currentFacet = IDiamondLoupe(lifiDiamond).facetAddress(
            RelayFacet.startBridgeTokensViaRelay.selector
        );
        assertEq(currentFacet, deployedRelayFacet);

        bytes32 consumedRequestId = keccak256("relay-replay-id-legacy-slot0");

        // Add a minimal legacy-writer facet and consume the ID through the diamond (delegatecall),
        // exercising the real storage slot calculation for the legacy slot-0 mapping layout.
        LegacyConsumedIdsFacet legacyWriter = new LegacyConsumedIdsFacet();
        bytes4[] memory legacySelectors = new bytes4[](1);
        legacySelectors[0] = LegacyConsumedIdsFacet.consume.selector;

        // Ensure selector isn't already present (safety / determinism).
        assertEq(
            IDiamondLoupe(lifiDiamond).facetAddress(legacySelectors[0]),
            address(0)
        );

        LibDiamond.FacetCut[] memory addCut = new LibDiamond.FacetCut[](1);
        addCut[0] = LibDiamond.FacetCut({
            facetAddress: address(legacyWriter),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: legacySelectors
        });

        // Upgrade: replace only the selector(s) we need with the new RelayFacet implementation.
        RelayFacet upgraded = new RelayFacet(address(0x1111), address(0x2222));

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = RelayFacet.startBridgeTokensViaRelay.selector;

        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        cut[0] = LibDiamond.FacetCut({
            facetAddress: address(upgraded),
            action: LibDiamond.FacetCutAction.Replace,
            functionSelectors: selectors
        });

        address owner = OwnershipFacet(lifiDiamond).owner();

        // 1) Add legacy-writer selector
        vm.startPrank(owner);
        DiamondCutFacet(lifiDiamond).diamondCut(addCut, address(0), "");
        vm.stopPrank();

        // 2) Consume before upgrading RelayFacet (simulates historical legacy storage usage)
        IConsumeFacet(lifiDiamond).consume(consumedRequestId);

        // Sanity: ensure legacy write landed in the expected mapping slot (slot 0 layout).
        bytes32 legacySlot = keccak256(
            abi.encode(consumedRequestId, uint256(0))
        );
        // Solidity stores `bool(true)` as `0x...01` (full 32-byte word).
        assertEq(vm.load(lifiDiamond, legacySlot), BOOL_TRUE_WORD);

        // 3) Upgrade RelayFacet selector
        vm.startPrank(owner);
        DiamondCutFacet(lifiDiamond).diamondCut(cut, address(0), "");
        vm.stopPrank();

        // Post-upgrade: the new RelayFacet must still block the legacy-consumed requestId.
        (
            ILiFi.BridgeData memory bridgeData,
            RelayFacet.RelayData memory relayData
        ) = getRelayFacetCallData(consumedRequestId);
        vm.expectRevert(RelayFacet.InvalidQuote.selector);
        RelayFacet(lifiDiamond).startBridgeTokensViaRelay(
            bridgeData,
            relayData
        );
    }

    function getRelayFacetCallData(
        bytes32 requestId
    )
        internal
        returns (
            ILiFi.BridgeData memory bridgeData,
            RelayFacet.RelayData memory relayData
        )
    {
        bridgeData = ILiFi.BridgeData({
            transactionId: keccak256("dummy-tx-id"),
            bridge: "relay",
            integrator: "",
            referrer: address(0),
            sendingAssetId: address(0),
            receiver: address(0xBEEF),
            minAmount: 1,
            destinationChainId: 1,
            hasSourceSwaps: false,
            hasDestinationCall: false
        });

        // Use a syntactically valid signature (65 bytes) so the call is stable even if the
        // implementation reaches signature verification (it should not for already-consumed ids).
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0x1234, bytes32(0));

        relayData = RelayFacet.RelayData({
            requestId: requestId,
            nonEVMReceiver: bytes32(0),
            receivingAssetId: bytes32(0),
            signature: abi.encodePacked(r, s, v)
        });
    }
}
