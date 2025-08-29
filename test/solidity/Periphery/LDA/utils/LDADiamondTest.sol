// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LDADiamond } from "lifi/Periphery/LDA/LDADiamond.sol";
import { LDADiamondCutFacet } from "lifi/Periphery/LDA/Facets/LDADiamondCutFacet.sol";
import { LDADiamondLoupeFacet } from "lifi/Periphery/LDA/Facets/LDADiamondLoupeFacet.sol";
import { LDAOwnershipFacet } from "lifi/Periphery/LDA/Facets/LDAOwnershipFacet.sol";
import { LDAPeripheryRegistryFacet } from "lifi/Periphery/LDA/Facets/LDAPeripheryRegistryFacet.sol";
import { LDAEmergencyPauseFacet } from "lifi/Periphery/LDA/Facets/LDAEmergencyPauseFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { BaseDiamondTest } from "../../../utils/BaseDiamondTest.sol";
import { TestBaseRandomConstants } from "../../../utils/TestBaseRandomConstants.sol";

/// @title LDADiamondTest
/// @notice Spins up a minimal LDA (LiFi DEX Aggregator) Diamond with loupe, ownership, and emergency pause facets for periphery tests.
/// @dev Child test suites inherit this to get a ready-to-cut diamond and helper to assemble facets.
contract LDADiamondTest is BaseDiamondTest, TestBaseRandomConstants {
    /// @notice The diamond proxy under test.
    LDADiamond internal ldaDiamond;

    /// @notice Deploys a clean LDA diamond with base facets and sets owner/pauser.
    /// @dev This runs before higher-level test setup in BaseCoreRouteTest/BaseDEXFacetTest.
    function setUp() public virtual {
        ldaDiamond = createLDADiamond(USER_LDA_DIAMOND_OWNER, USER_LDA_PAUSER);
    }

    /// @notice Creates an LDA diamond and wires up Loupe, Ownership and EmergencyPause facets.
    /// @param _diamondOwner Owner address for the diamond.
    /// @param _pauserWallet Pauser address for the emergency pause facet.
    /// @return diamond The newly created diamond instance.
    function createLDADiamond(
        address _diamondOwner,
        address _pauserWallet
    ) internal returns (LDADiamond) {
        vm.startPrank(_diamondOwner);
        LDADiamondCutFacet diamondCut = new LDADiamondCutFacet();
        LDADiamondLoupeFacet diamondLoupe = new LDADiamondLoupeFacet();
        LDAOwnershipFacet ownership = new LDAOwnershipFacet();
        LDAEmergencyPauseFacet emergencyPause = new LDAEmergencyPauseFacet(
            _pauserWallet
        );
        LDADiamond diamond = new LDADiamond(
            _diamondOwner,
            address(diamondCut)
        );
        LDAPeripheryRegistryFacet periphery = new LDAPeripheryRegistryFacet();

        // Add Diamond Loupe
        _addDiamondLoupeSelectors(address(diamondLoupe));

        // Add Ownership
        _addOwnershipSelectors(address(ownership));

        // Add PeripheryRegistry
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = LDAPeripheryRegistryFacet
            .registerPeripheryContract
            .selector;
        functionSelectors[1] = LDAPeripheryRegistryFacet
            .getPeripheryContract
            .selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(periphery),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // Add EmergencyPause
        functionSelectors = new bytes4[](3);
        functionSelectors[0] = emergencyPause.removeFacet.selector;
        functionSelectors[1] = emergencyPause.pauseDiamond.selector;
        functionSelectors[2] = emergencyPause.unpauseDiamond.selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(emergencyPause),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        LDADiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");
        delete cut;
        vm.stopPrank();
        return diamond;
    }

    /// @notice Tests that diamond creation fails when owner address is zero
    function testRevert_CannotDeployDiamondWithZeroOwner() public {
        address diamondCutFacet = address(new LDADiamondCutFacet());

        vm.expectRevert(InvalidConfig.selector);
        new LDADiamond(
            address(0), // Zero owner address
            diamondCutFacet
        );
    }

    function testRevert_CannotDeployDiamondWithZeroDiamondCut() public {
        vm.expectRevert(InvalidConfig.selector);
        new LDADiamond(
            USER_DIAMOND_OWNER,
            address(0) // Zero diamondCut address
        );
    }

    function testRevert_CannotCallNonExistentFunction() public {
        // Create arbitrary calldata with non-existent selector
        bytes memory nonExistentCalldata = abi.encodeWithSelector(
            bytes4(keccak256("nonExistentFunction()")),
            ""
        );

        vm.expectRevert(LibDiamond.FunctionDoesNotExist.selector);
        (bool success, bytes memory returnData) = address(ldaDiamond).call(
            nonExistentCalldata
        );
        success; // silence unused variable warning
        returnData; // silence unused variable warning
    }

    function testRevert_CannotCallUnregisteredSelector() public {
        // Use a real function selector that exists but hasn't been registered yet
        bytes memory unregisteredCalldata = abi.encodeWithSelector(
            LDADiamondCutFacet.diamondCut.selector, // Valid selector but not registered yet
            new LibDiamond.FacetCut[](0),
            address(0),
            ""
        );

        vm.expectRevert(LibDiamond.FunctionDoesNotExist.selector);
        // solhint-disable-next-line unused-return
        (bool success, bytes memory returnData) = address(ldaDiamond).call(
            unregisteredCalldata
        );
        success; // silence unused variable warning
        returnData; // silence unused variable warning
    }
}
