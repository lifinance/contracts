// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.17;

import { LiFiDiamondImmutable } from "lifi/LiFiDiamondImmutable.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";
import { OwnershipFacet } from "lifi/Facets/OwnershipFacet.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";

contract LiFiDiamondImmutableTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    LiFiDiamondImmutable public diamond;
    DiamondCutFacet public diamondCutFacet;
    OwnershipFacet public ownershipFacet;
    address public diamondOwner;

    event DiamondCut(
        IDiamondCut.FacetCut[] _diamondCut,
        address _init,
        bytes _calldata
    );

    event OwnershipTransferred(
        address indexed previousOwner,
        address indexed newOwner
    );

    error FunctionDoesNotExist();
    error OnlyContractOwner();

    function setUp() public {
        diamondOwner = address(123456);
        diamondCutFacet = new DiamondCutFacet();
        ownershipFacet = new OwnershipFacet();

        // prepare function selector for diamondCut (OwnershipFacet)
        bytes4[] memory functionSelectors = new bytes4[](1);
        functionSelectors[0] = ownershipFacet.owner.selector;

        // prepare parameters for diamondCut (OwnershipFacet)
        IDiamondCut.FacetCut[] memory cut = new IDiamondCut.FacetCut[](1);
        cut[0] = IDiamondCut.FacetCut({
            facetAddress: address(ownershipFacet),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: functionSelectors
        });

        diamond = new LiFiDiamondImmutable(
            diamondOwner,
            address(diamondCutFacet)
        );
    }

    function test_DeploysWithoutErrors() public {
        diamond = new LiFiDiamondImmutable(
            diamondOwner,
            address(diamondCutFacet)
        );
    }

    function test_ForwardsCallsViaDelegateCall() public {
        // only one facet with one selector is registered (diamondCut)
        vm.startPrank(diamondOwner);

        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();

        // make sure that this call fails (without ending the test)
        bool failed = false;
        try DiamondLoupeFacet(address(diamond)).facetAddresses() returns (
            address[] memory
        ) {} catch {
            failed = true;
        }
        if (!failed) revert("InvalidDiamondSetup");

        // prepare function selectors
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = diamondLoupe.facets.selector;
        functionSelectors[1] = diamondLoupe.facetFunctionSelectors.selector;
        functionSelectors[2] = diamondLoupe.facetAddresses.selector;
        functionSelectors[3] = diamondLoupe.facetAddress.selector;

        // prepare diamondCut
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupe),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: functionSelectors
        });

        DiamondCutFacet(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function test_NonOwnerCannotAddFacet() public {
        DiamondLoupeFacet diamondLoupe = new DiamondLoupeFacet();

        // prepare function selectors
        bytes4[] memory functionSelectors = new bytes4[](4);
        functionSelectors[0] = diamondLoupe.facets.selector;
        functionSelectors[1] = diamondLoupe.facetFunctionSelectors.selector;
        functionSelectors[2] = diamondLoupe.facetAddresses.selector;
        functionSelectors[3] = diamondLoupe.facetAddress.selector;

        // prepare diamondCut
        IDiamondCut.FacetCut[] memory cuts = new IDiamondCut.FacetCut[](1);
        cuts[0] = IDiamondCut.FacetCut({
            facetAddress: address(diamondLoupe),
            action: IDiamondCut.FacetCutAction.Add,
            functionSelectors: functionSelectors
        });

        vm.expectRevert(OnlyContractOwner.selector);
        DiamondCutFacet(address(diamond)).diamondCut(cuts, address(0), "");
    }

    function test_RevertsOnUnknownFunctionSelector() public {
        // call random function selectors
        bytes memory callData = hex"a516f0f3"; // getPeripheryContract(string)

        vm.expectRevert(FunctionDoesNotExist.selector);
        (bool success, ) = address(diamond).call(callData);
        if (!success) revert("ShouldNotReachThisCode"); // was only added to silence a compiler warning
    }

    function test_CanReceiveETH() public {
        (bool success, ) = address(diamond).call{ value: 1 ether }("");
        if (!success) revert("ExternalCallFailed");

        assertEq(address(diamond).balance, 1 ether);
    }
}
