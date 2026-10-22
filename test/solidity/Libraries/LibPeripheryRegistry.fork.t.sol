// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";

import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { IERC173 } from "lifi/Interfaces/IERC173.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";

import { LibPeripheryRegistry } from "lifi/Libraries/LibPeripheryRegistry.sol";
import { RegistryProbeFacet } from "../Facets/AttestedBridgeFacet/AttestedBridgeFacet.t.sol";

contract LibPeripheryRegistryForkTest is Test {
    address internal constant LIFI_DIAMOND =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    uint256 internal constant BASE_FORK_BLOCK = 51_738_000;
    /// @dev From `deployments/base.diamond.json`, version 1.0.0
    address internal constant PERIPHERY_REGISTRY_FACET =
        0xf1269030deB739edB0b7dABA9b701E102116d86c;

    address internal diamondOwner;

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

        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = RegistryProbeFacet.probePeripheryRegistry.selector;
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        cut[0] = LibDiamond.FacetCut(
            address(new RegistryProbeFacet()),
            LibDiamond.FacetCutAction.Add,
            selectors
        );
        vm.prank(diamondOwner);
        IDiamondCut(LIFI_DIAMOND).diamondCut(cut, address(0), "");
    }

    function test_GetMatchesTheRegistryFacetAndTheSlot() public {
        bytes32 namespace = 0xddb1a97e204589b19d70796e7a3363c86670116d11313290b7a7eb064a8f3da1;
        bytes32 slot = 0x2ea1c0530bb78d2f977ca48354f502a4489c9a6563d07a122a90ebb900c253fd;
        string memory key = "BridgeAttester";
        address attester = makeAddr("attester");

        assertEq(
            IDiamondLoupe(LIFI_DIAMOND).facetAddress(
                PeripheryRegistryFacet.getPeripheryContract.selector
            ),
            PERIPHERY_REGISTRY_FACET
        );
        assertEq(LibPeripheryRegistry.NAMESPACE, namespace);
        assertEq(keccak256(abi.encodePacked(key, namespace)), slot);
        assertEq(
            PeripheryRegistryFacet(LIFI_DIAMOND).getPeripheryContract(key),
            address(0)
        );
        assertEq(vm.load(LIFI_DIAMOND, slot), bytes32(0));

        vm.prank(diamondOwner);
        PeripheryRegistryFacet(LIFI_DIAMOND).registerPeripheryContract(
            key,
            attester
        );

        assertEq(
            PeripheryRegistryFacet(LIFI_DIAMOND).getPeripheryContract(key),
            attester
        );
        assertEq(
            RegistryProbeFacet(LIFI_DIAMOND).probePeripheryRegistry(key),
            attester
        );
        assertEq(
            vm.load(LIFI_DIAMOND, slot),
            bytes32(uint256(uint160(attester)))
        );
    }

    function test_GetMatchesTheRegistryFacetForLiveKeys() public view {
        string[4] memory keys = [
            "Executor",
            "ERC20Proxy",
            "FeeCollector",
            "Permit2Proxy"
        ];
        for (uint256 i; i < keys.length; ++i) {
            address registered = PeripheryRegistryFacet(LIFI_DIAMOND)
                .getPeripheryContract(keys[i]);

            assertTrue(registered != address(0), keys[i]);
            assertEq(
                RegistryProbeFacet(LIFI_DIAMOND).probePeripheryRegistry(
                    keys[i]
                ),
                registered,
                keys[i]
            );
        }
    }
}
