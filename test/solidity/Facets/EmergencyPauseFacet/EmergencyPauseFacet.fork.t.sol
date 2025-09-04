// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LibAllowList, TestBase } from "../../utils/TestBase.sol";
import { OnlyContractOwner, UnAuthorized, DiamondIsPaused } from "src/Errors/GenericErrors.sol";
import { EmergencyPauseFacet } from "lifi/Facets/EmergencyPauseFacet.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { DiamondLoupeFacet } from "lifi/Facets/DiamondLoupeFacet.sol";

// Stub EmergencyPauseFacet Contract
contract TestEmergencyPauseFacet is EmergencyPauseFacet {
    constructor(address _pauserWallet) EmergencyPauseFacet(_pauserWallet) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract EmergencyPauseFacetPRODTest is TestBase {
    // EVENTS
    event EmergencyFacetRemoved(
        address indexed facetAddress,
        address indexed msgSender
    );
    event EmergencyPaused(address indexed msgSender);
    event EmergencyUnpaused(address indexed msgSender);

    // STORAGE
    address internal constant ADDRESS_DIAMOND_MAINNET =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;
    address internal constant USER_DIAMOND_OWNER_MAINNET =
        0x37347dD595C49212C5FC2D95EA10d1085896f51E;
    TestEmergencyPauseFacet internal emergencyPauseFacetTest;
    address[] internal blacklist = new address[](0);

    function setUp() public override {
        // set custom block number for forking
        customBlockNumberForForking = 19979843;

        initTestBase();

        // deploy EmergencyPauseFacet
        emergencyPauseFacetTest = new TestEmergencyPauseFacet(USER_PAUSER);

        // prepare diamondCut
        bytes4[] memory functionSelectors = new bytes4[](3);
        functionSelectors[0] = emergencyPauseFacetTest.removeFacet.selector;
        functionSelectors[1] = emergencyPauseFacetTest.pauseDiamond.selector;
        functionSelectors[2] = emergencyPauseFacetTest.unpauseDiamond.selector;

        cut.push(
            LibDiamond.FacetCut({
                facetAddress: address(emergencyPauseFacetTest),
                action: LibDiamond.FacetCutAction.Add,
                functionSelectors: functionSelectors
            })
        );

        // add EmergencyPauseFacet to PROD diamond
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);
        DiamondCutFacet(address(ADDRESS_DIAMOND_MAINNET)).diamondCut(
            cut,
            address(0),
            ""
        );

        // store diamond in local TestEmergencyPauseFacet variable
        emergencyPauseFacetTest = TestEmergencyPauseFacet(
            payable(address(ADDRESS_DIAMOND_MAINNET))
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(emergencyPauseFacetTest),
            "EmergencyPauseFacet"
        );

        vm.stopPrank();
    }

    function test_PauserWalletCanPauseDiamond() public {
        vm.startPrank(USER_PAUSER);
        vm.expectEmit(
            true,
            true,
            true,
            true,
            address(emergencyPauseFacetTest)
        );
        emit EmergencyPaused(USER_PAUSER);
        // pause the contract
        emergencyPauseFacetTest.pauseDiamond();
        // try to get a list of all registered facets via DiamondLoupe
        vm.expectRevert(DiamondIsPaused.selector);
        DiamondLoupeFacet(address(emergencyPauseFacetTest)).facets();
    }

    function test_DiamondOwnerCanPauseDiamond() public {
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(
            true,
            true,
            true,
            true,
            address(emergencyPauseFacetTest)
        );
        emit EmergencyPaused(USER_DIAMOND_OWNER_MAINNET);

        // pause the contract
        emergencyPauseFacetTest.pauseDiamond();

        // try to get a list of all registered facets via DiamondLoupe
        vm.expectRevert(DiamondIsPaused.selector);
        DiamondLoupeFacet(address(emergencyPauseFacetTest)).facets();
    }

    function test_UnauthorizedWalletCannotPauseDiamond() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        // pause the contract
        emergencyPauseFacetTest.pauseDiamond();

        vm.startPrank(USER_RECEIVER);
        vm.expectRevert(UnAuthorized.selector);
        // pause the contract
        emergencyPauseFacetTest.pauseDiamond();
    }

    function test_DiamondOwnerCanUnpauseDiamond() public {
        IDiamondLoupe.Facet[] memory initialFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        // pause diamond first
        test_PauserWalletCanPauseDiamond();

        // unpause diamond as owner
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(
            true,
            true,
            true,
            true,
            address(emergencyPauseFacetTest)
        );
        emit EmergencyUnpaused(USER_DIAMOND_OWNER_MAINNET);

        emergencyPauseFacetTest.unpauseDiamond(blacklist);

        // make sure diamond works normal again and has all facets reinstated
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        assertTrue(initialFacets.length == finalFacets.length);
    }

    function test_UnauthorizedWalletCannotUnpauseDiamond() public {
        // pause diamond first
        test_PauserWalletCanPauseDiamond();

        // try to pause the diamond with various wallets
        vm.startPrank(USER_PAUSER);
        vm.expectRevert(OnlyContractOwner.selector);
        emergencyPauseFacetTest.unpauseDiamond(blacklist);

        vm.startPrank(USER_RECEIVER);
        vm.expectRevert(OnlyContractOwner.selector);
        emergencyPauseFacetTest.unpauseDiamond(blacklist);

        // make sure diamond is still paused
        vm.expectRevert(DiamondIsPaused.selector);
        DiamondLoupeFacet(address(emergencyPauseFacetTest)).facets();
    }

    function test_DiamondOwnerCanRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        // get PeripheryRegistryFacet address
        address facetAddress = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            );

        // remove facet
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(
            true,
            true,
            true,
            true,
            address(emergencyPauseFacetTest)
        );
        emit EmergencyFacetRemoved(facetAddress, USER_DIAMOND_OWNER_MAINNET);

        emergencyPauseFacetTest.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        // ensure that one facet less is registered now
        assertTrue(initialFacets.length == finalFacets.length + 1);
        // ensure that PeripheryRegistryFacet function selector is not associated to any facetAddress
        assertTrue(
            DiamondLoupeFacet(address(emergencyPauseFacetTest)).facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            ) == address(0)
        );

        vm.stopPrank();
    }

    function test_PauserWalletCanRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        // get PeripheryRegistryFacet address
        address facetAddress = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacetTest))
                    .registerPeripheryContract
                    .selector
            );

        // remove facet
        vm.startPrank(USER_PAUSER);

        vm.expectEmit(
            true,
            true,
            true,
            true,
            address(emergencyPauseFacetTest)
        );
        emit EmergencyFacetRemoved(facetAddress, USER_PAUSER);

        emergencyPauseFacetTest.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        // ensure that one facet less is registered now
        assertTrue(initialFacets.length == finalFacets.length + 1);
        // ensure that PeripheryRegistryFacet function selector is not associated to any facetAddress
        assertTrue(
            DiamondLoupeFacet(address(emergencyPauseFacetTest)).facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacetTest))
                    .registerPeripheryContract
                    .selector
            ) == address(0)
        );

        vm.stopPrank();
    }

    function test_UnauthorizedWalletCannotRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        // get PeripheryRegistryFacet address
        address facetAddress = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacetTest))
                    .registerPeripheryContract
                    .selector
            );

        // try to remove facet
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        emergencyPauseFacetTest.removeFacet(facetAddress);

        vm.startPrank(USER_RECEIVER);
        vm.expectRevert(UnAuthorized.selector);
        emergencyPauseFacetTest.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
            address(emergencyPauseFacetTest)
        ).facets();

        // ensure that number of facets remains unchanged
        assertTrue(initialFacets.length == finalFacets.length);
    }
}
