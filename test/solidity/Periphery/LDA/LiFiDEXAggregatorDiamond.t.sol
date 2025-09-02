// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LiFiDEXAggregatorDiamond } from "lifi/Periphery/LDA/LiFiDEXAggregatorDiamond.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { DiamondTest } from "../../utils/DiamondTest.sol";

/// @title LiFiDEXAggregatorDiamondTest
/// @notice Spins up a minimal LDA (LiFi DEX Aggregator) Diamond with loupe, ownership, and emergency pause facets for periphery tests.
/// @dev Child test suites inherit this to get a ready-to-cut diamond and helper to assemble facets.
contract LiFiDEXAggregatorDiamondTest is DiamondTest {
    LiFiDEXAggregatorDiamond public ldaDiamond;

    event DiamondCut(
        LibDiamond.FacetCut[] _diamondCut,
        address _init,
        bytes _calldata
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    error FunctionDoesNotExist();
    error ShouldNotReachThisCode();
    error InvalidDiamondSetup();
    error ExternalCallFailed();

    function setUp() public virtual override {
        super.setUp();

        ldaDiamond = new LiFiDEXAggregatorDiamond(
            USER_LDA_DIAMOND_OWNER,
            address(diamondCutFacet)
        );
        // prepare function selector for diamondCut (OwnershipFacet)
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = ownershipFacet.owner.selector;

        // prepare parameters for diamondCut (OwnershipFacet)
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        cut[0] = LibDiamond.FacetCut({
            facetAddress: address(ownershipFacet),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: functionSelectors
        });

        vm.prank(USER_LDA_DIAMOND_OWNER);
        DiamondCutFacet(address(ldaDiamond)).diamondCut(cut, address(0), "");
    }

    function test_DeploysWithoutErrors() public virtual {
        ldaDiamond = new LiFiDEXAggregatorDiamond(
            USER_LDA_DIAMOND_OWNER,
            address(diamondCutFacet)
        );
    }

    function test_ForwardsCallsViaDelegateCall() public {
        // only one facet with one selector is registered (diamondCut)
        vm.startPrank(USER_LDA_DIAMOND_OWNER);

        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();

        // make sure that this call fails (without ending the test)
        bool failed = false;
        try DiamondLoupeFacet(address(ldaDiamond)).facetAddresses() returns (
            address[] memory
        ) {} catch {
            failed = true;
        }
        if (!failed) revert InvalidDiamondSetup();

        // prepare function selectors
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = diamondLoupe.facets.selector;
        functionSelectors[1] = diamondLoupe.facetFunctionSelectors.selector;
        functionSelectors[2] = diamondLoupe.facetAddresses.selector;
        functionSelectors[3] = diamondLoupe.facetAddress.selector;

        // prepare diamondCut
        LibDiamond.FacetCut[] memory cuts = new LibDiamond.FacetCut[](1);
        cuts[0] = LibDiamond.FacetCut({
            facetAddress: address(diamondLoupe),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: functionSelectors
        });

        DiamondCutFacet(address(ldaDiamond)).diamondCut(cuts, address(0), "");
    }

    function test_RevertsOnUnknownFunctionSelector() public {
        // call random function selectors
        bytes memory callData = hex"a516f0f3"; // getPeripheryContract(string)

        vm.expectRevert(FunctionDoesNotExist.selector);
        (bool success, ) = address(ldaDiamond).call(callData);
        if (!success) revert ShouldNotReachThisCode(); // was only added to silence a compiler warning
    }

    function test_CanReceiveETH() public {
        (bool success, ) = address(ldaDiamond).call{ value: 1 ether }("");
        if (!success) revert ExternalCallFailed();

        assertEq(address(ldaDiamond).balance, 1 ether);
    }
}
