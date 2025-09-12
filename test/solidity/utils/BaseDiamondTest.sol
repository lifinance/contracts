// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { EmergencyPauseFacet } from "lifi/Facets/EmergencyPauseFacet.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondTestHelpers } from "./DiamondTestHelpers.sol";

/// @notice Base contract with common diamond test functions to reduce code duplication
/// @dev Provides standard test patterns that work with any diamond implementation
abstract contract BaseDiamondTest is DiamondTestHelpers {
    // Main diamond instance - accessible to all inheriting contracts including TestBase
    LiFiDiamond internal diamond;

    // Common facet instances
    DiamondCutFacet internal diamondCutFacet;
    OwnershipFacet internal ownershipFacet;
    DiamondLoupeFacet internal diamondLoupeFacet;
    PeripheryRegistryFacet internal peripheryFacet;
    EmergencyPauseFacet internal emergencyPauseFacet;

    // Events
    event DiamondCut(
        LibDiamond.FacetCut[] _diamondCut,
        address _init,
        bytes _calldata
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    // Errors
    error FunctionDoesNotExist();
    error ShouldNotReachThisCode();
    error InvalidDiamondSetup();
    error ExternalCallFailed();

    function setUp() public virtual {
        // Create the main LiFiDiamond that TestBase and other facet tests expect
        diamond = createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
    }

    /// @notice Creates a fully configured diamond with all standard facets
    /// @param _diamondOwner Owner address for the diamond
    /// @param _pauserWallet Pauser wallet address for emergency pause facet
    /// @return The created LiFiDiamond instance
    function createDiamond(
        address _diamondOwner,
        address _pauserWallet
    ) internal returns (LiFiDiamond) {
        vm.startPrank(_diamondOwner);

        // Recreate facets with the specified pauser
        diamondCutFacet = new DiamondCutFacet();
        diamondLoupeFacet = new DiamondLoupeFacet();
        ownershipFacet = new OwnershipFacet();
        peripheryFacet = new PeripheryRegistryFacet();
        emergencyPauseFacet = new EmergencyPauseFacet(_pauserWallet);

        // Create new diamond
        diamond = new LiFiDiamond(_diamondOwner, address(diamondCutFacet));

        // Add Diamond Loupe
        _addDiamondLoupeSelectors(address(diamondLoupeFacet));

        // Add Ownership
        _addOwnershipSelectors(address(ownershipFacet));

        // Add PeripheryRegistry
        bytes4[] memory functionSelectors = new bytes4[](2);
        functionSelectors[0] = PeripheryRegistryFacet
            .registerPeripheryContract
            .selector;
        functionSelectors[1] = PeripheryRegistryFacet
            .getPeripheryContract
            .selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(peripheryFacet),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // Add EmergencyPause
        functionSelectors = new bytes4[](3);
        functionSelectors[0] = emergencyPauseFacet.removeFacet.selector;
        functionSelectors[1] = emergencyPauseFacet.pauseDiamond.selector;
        functionSelectors[2] = emergencyPauseFacet.unpauseDiamond.selector;
        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(emergencyPauseFacet),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        DiamondCutFacet(address(diamond)).diamondCut(cut, address(0), "");
        delete cut;
        vm.stopPrank();
        return diamond;
    }

    /// @notice Override this to return the diamond address for testing
    function getDiamondAddress() internal view virtual returns (address) {
        return address(diamond);
    }

    /// @notice Override this to return the diamond owner address
    function getDiamondOwner() internal view virtual returns (address) {
        return USER_DIAMOND_OWNER;
    }

    /// @notice Test that diamond deployment works without errors
    function test_DeploysWithoutErrors() public virtual {
        assertTrue(
            getDiamondAddress() != address(0),
            "Diamond should be deployed"
        );
    }

    /// @notice Test that diamond forwards calls via delegate call
    function test_ForwardsCallsViaDelegateCall() public {
        address diamondAddr = getDiamondAddress();
        address owner = getDiamondOwner();

        vm.startPrank(owner);

        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();

        // Check if DiamondLoupeFacet is already installed
        bool loupeAlreadyInstalled = false;
        try DiamondLoupeFacet(diamondAddr).facetAddresses() returns (
            address[] memory
        ) {
            loupeAlreadyInstalled = true;
        } catch {
            // Loupe not installed, which is expected for basic diamonds
        }

        if (!loupeAlreadyInstalled) {
            // prepare function selectors
            bytes4[] memory functionSelectors = new bytes4[](4);
            functionSelectors[0] = diamondLoupe.facets.selector;
            functionSelectors[1] = diamondLoupe
                .facetFunctionSelectors
                .selector;
            functionSelectors[2] = diamondLoupe.facetAddresses.selector;
            functionSelectors[3] = diamondLoupe.facetAddress.selector;

            // prepare diamondCut
            LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](1);
            cuts[0] = LibDiamond.FacetCut({
                facetAddress: address(diamondLoupe),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            });

            DiamondCutFacet(diamondAddr).diamondCut(cuts, address(0), "");
        }

        // Now the call should succeed
        address[] memory facetAddresses = DiamondLoupeFacet(diamondAddr)
            .facetAddresses();
        assertTrue(
            facetAddresses.length > 0,
            "Should have facets after adding DiamondLoupe"
        );

        vm.stopPrank();
    }

    /// @notice Test that diamond reverts on unknown function selectors
    function test_RevertsOnUnknownFunctionSelector() public {
        address diamondAddr = getDiamondAddress();

        // Use a completely random selector that definitely doesn't exist
        bytes memory callData = hex"deadbeef";

        vm.expectRevert(FunctionDoesNotExist.selector);
        (bool success, ) = diamondAddr.call(callData);
        if (!success) {
            vm.expectRevert("Diamond: Function does not exist");
            (bool success2, ) = diamondAddr.call(callData);
            if (!success2) {
                revert ShouldNotReachThisCode();
            }
        }
    }

    /// @notice Test that diamond can receive ETH
    function test_CanReceiveETH() public {
        address diamondAddr = getDiamondAddress();
        uint256 balanceBefore = diamondAddr.balance;
        (bool success, ) = diamondAddr.call{ value: 1 ether }("");
        if (!success) revert ExternalCallFailed();

        assertEq(address(diamond).balance, balanceBefore + 1 ether);
    }

    /// @notice Test that diamond owner was correctly registered
    function test_DiamondOwnerIsCorrectlyRegistered() public {
        address diamondAddr = getDiamondAddress();
        address expectedOwner = getDiamondOwner();

        // Get the actual owner from the diamond
        address actualOwner = OwnershipFacet(diamondAddr).owner();

        assertEq(
            actualOwner,
            expectedOwner,
            "Diamond owner should match expected owner"
        );
    }
}
