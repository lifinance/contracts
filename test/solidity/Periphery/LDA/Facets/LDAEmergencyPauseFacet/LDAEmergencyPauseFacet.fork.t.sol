// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibAllowList, TestBase } from "../../../../utils/TestBase.sol";
import { OnlyContractOwner, UnAuthorized, DiamondIsPaused } from "lifi/Errors/GenericErrors.sol";
import { LDAEmergencyPauseFacet } from "lifi/Periphery/LDA/Facets/LDAEmergencyPauseFacet.sol";
import { LDAPeripheryRegistryFacet } from "lifi/Periphery/LDA/Facets/LDAPeripheryRegistryFacet.sol";
import { LDADiamondCutFacet } from "lifi/Periphery/LDA/Facets/LDADiamondCutFacet.sol";
import { LibDiamond } from "lifi/Libraries/LibDiamond.sol";
import { IDiamondLoupe } from "lifi/Interfaces/IDiamondLoupe.sol";
import { LDADiamondLoupeFacet } from "lifi/Periphery/LDA/Facets/LDADiamondLoupeFacet.sol";

// Stub EmergencyPauseFacet Contract
contract TestEmergencyPauseFacet is LDAEmergencyPauseFacet {
    constructor(address _pauserWallet) LDAEmergencyPauseFacet(_pauserWallet) {}

    function addDex(address _dex) external {
        LibAllowList.addAllowedContract(_dex);
    }

    function setFunctionApprovalBySignature(bytes4 _signature) external {
        LibAllowList.addAllowedSelector(_signature);
    }
}

contract LDAEmergencyPauseFacetPRODTest is TestBase {
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
    TestEmergencyPauseFacet internal emergencyPauseFacet;
    address[] internal blacklist = new address[](0);

    function setUp() public override {
        // set custom block number for forking
        customBlockNumberForForking = 19979843;

        initTestBase();

        // deploy EmergencyPauseFacet
        emergencyPauseFacet = new TestEmergencyPauseFacet(USER_PAUSER);

        // prepare diamondCut
        bytes4[] memory functionSelectors = new bytes4[](3);
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

        // add EmergencyPauseFacet to PROD diamond
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);
        LDADiamondCutFacet(address(ADDRESS_DIAMOND_MAINNET)).diamondCut(
            cut,
            address(0),
            ""
        );

        // store diamond in local TestEmergencyPauseFacet variable
        emergencyPauseFacet = TestEmergencyPauseFacet(
            payable(address(ADDRESS_DIAMOND_MAINNET))
        );

        // set facet address in TestBase
        setFacetAddressInTestBase(
            address(emergencyPauseFacet),
            "EmergencyPauseFacet"
        );

        vm.stopPrank();
    }

    function test_PauserWalletCanPauseDiamond() public {
        vm.startPrank(USER_PAUSER);
        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyPaused(USER_PAUSER);
        // pause the contract
        emergencyPauseFacet.pauseDiamond();
        // try to get a list of all registered facets via DiamondLoupe
        vm.expectRevert(DiamondIsPaused.selector);
        LDADiamondLoupeFacet(address(emergencyPauseFacet)).facets();
    }

    function test_DiamondOwnerCanPauseDiamond() public {
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyPaused(USER_DIAMOND_OWNER_MAINNET);

        // pause the contract
        emergencyPauseFacet.pauseDiamond();

        // try to get a list of all registered facets via DiamondLoupe
        vm.expectRevert(DiamondIsPaused.selector);
        LDADiamondLoupeFacet(address(emergencyPauseFacet)).facets();
    }

    function test_UnauthorizedWalletCannotPauseDiamond() public {
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        // pause the contract
        emergencyPauseFacet.pauseDiamond();

        vm.startPrank(USER_RECEIVER);
        vm.expectRevert(UnAuthorized.selector);
        // pause the contract
        emergencyPauseFacet.pauseDiamond();
    }

    function test_DiamondOwnerCanUnpauseDiamond() public {
        IDiamondLoupe.Facet[] memory initialFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // pause diamond first
        test_PauserWalletCanPauseDiamond();

        // unpause diamond as owner
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyUnpaused(USER_DIAMOND_OWNER_MAINNET);

        emergencyPauseFacet.unpauseDiamond(blacklist);

        // make sure diamond works normal again and has all facets reinstated
        IDiamondLoupe.Facet[] memory finalFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        assertTrue(initialFacets.length == finalFacets.length);
    }

    function test_UnauthorizedWalletCannotUnpauseDiamond() public {
        // pause diamond first
        test_PauserWalletCanPauseDiamond();

        // try to pause the diamond with various wallets
        vm.startPrank(USER_PAUSER);
        vm.expectRevert(OnlyContractOwner.selector);
        emergencyPauseFacet.unpauseDiamond(blacklist);

        vm.startPrank(USER_RECEIVER);
        vm.expectRevert(OnlyContractOwner.selector);
        emergencyPauseFacet.unpauseDiamond(blacklist);

        // make sure diamond is still paused
        vm.expectRevert(DiamondIsPaused.selector);
        LDADiamondLoupeFacet(address(emergencyPauseFacet)).facets();
    }

    function test_DiamondOwnerCanRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // get LDAPeripheryRegistryFacet address
        address facetAddress = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facetAddress(
                LDAPeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            );

        // remove facet
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyFacetRemoved(facetAddress, USER_DIAMOND_OWNER_MAINNET);

        emergencyPauseFacet.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // ensure that one facet less is registered now
        assertTrue(initialFacets.length == finalFacets.length + 1);
        // ensure that LDAPeripheryRegistryFacet function selector is not associated to any facetAddress
        assertTrue(
            LDADiamondLoupeFacet(address(emergencyPauseFacet)).facetAddress(
                LDAPeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            ) == address(0)
        );

        vm.stopPrank();
    }

    function test_PauserWalletCanRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // get PeripheryRegistryFacet address
        address facetAddress = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facetAddress(
                LDAPeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            );

        // remove facet
        vm.startPrank(USER_PAUSER);

        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyFacetRemoved(facetAddress, USER_PAUSER);

        emergencyPauseFacet.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // ensure that one facet less is registered now
        assertTrue(initialFacets.length == finalFacets.length + 1);
        // ensure that LDAPeripheryRegistryFacet function selector is not associated to any facetAddress
        assertTrue(
            LDADiamondLoupeFacet(address(emergencyPauseFacet)).facetAddress(
                LDAPeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            ) == address(0)
        );

        vm.stopPrank();
    }

    function test_UnauthorizedWalletCannotRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // get LDAPeripheryRegistryFacet address
        address facetAddress = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facetAddress(
                LDAPeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            );

        // try to remove facet
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        emergencyPauseFacet.removeFacet(facetAddress);

        vm.startPrank(USER_RECEIVER);
        vm.expectRevert(UnAuthorized.selector);
        emergencyPauseFacet.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = LDADiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // ensure that number of facets remains unchanged
        assertTrue(initialFacets.length == finalFacets.length);
    }
}
