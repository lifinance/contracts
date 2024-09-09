// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { LibAllowList, TestBase, console, LiFiDiamond } from "../utils/TestBase.sol";
import { OnlyContractOwner, InvalidConfig, NotInitialized, InformationMismatch, AlreadyInitialized, UnAuthorized, DiamondIsPaused } from "src/Errors/GenericErrors.sol";
import { EmergencyPauseFacet } from "lifi/Facets/EmergencyPauseFacet.sol";
import { PeripheryRegistryFacet } from "lifi/Facets/PeripheryRegistryFacet.sol";
import { DiamondCutFacet } from "lifi/Facets/DiamondCutFacet.sol";
import { IStargate, ITokenMessaging } from "lifi/Interfaces/IStargate.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { ILiFi } from "lifi/Interfaces/ILiFi.sol";
import { LibSwap } from "lifi/Libraries/LibSwap.sol";
import { IDiamondCut } from "lifi/Interfaces/IDiamondCut.sol";
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
    TestEmergencyPauseFacet internal emergencyPauseFacet;
    address[] internal blacklist = new address[](0);

    function setUp() public {
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
            IDiamondCut.FacetCut({
                facetAddress: address(emergencyPauseFacet),
                action: IDiamondCut.FacetCutAction.Add,
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
        DiamondLoupeFacet(address(emergencyPauseFacet)).facets();
    }

    function test_DiamondOwnerCanPauseDiamond() public {
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyPaused(USER_DIAMOND_OWNER_MAINNET);

        // pause the contract
        emergencyPauseFacet.pauseDiamond();

        // try to get a list of all registered facets via DiamondLoupe
        vm.expectRevert(DiamondIsPaused.selector);
        DiamondLoupeFacet(address(emergencyPauseFacet)).facets();
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
        IDiamondLoupe.Facet[] memory initialFacets = DiamondLoupeFacet(
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
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
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
        DiamondLoupeFacet(address(emergencyPauseFacet)).facets();
    }

    function test_DiamondOwnerCanRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = DiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // get PeripheryRegistryFacet address
        address facetAddress = DiamondLoupeFacet(address(emergencyPauseFacet))
            .facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            );

        // remove facet
        vm.startPrank(USER_DIAMOND_OWNER_MAINNET);

        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyFacetRemoved(facetAddress, USER_DIAMOND_OWNER_MAINNET);

        emergencyPauseFacet.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // ensure that one facet less is registered now
        assertTrue(initialFacets.length == finalFacets.length + 1);
        // ensure that PeripheryRegistryFacet function selector is not associated to any facetAddress
        assertTrue(
            DiamondLoupeFacet(address(emergencyPauseFacet)).facetAddress(
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
            address(emergencyPauseFacet)
        ).facets();

        // get PeripheryRegistryFacet address
        address facetAddress = DiamondLoupeFacet(address(emergencyPauseFacet))
            .facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            );

        // remove facet
        vm.startPrank(USER_PAUSER);

        vm.expectEmit(true, true, true, true, address(emergencyPauseFacet));
        emit EmergencyFacetRemoved(facetAddress, USER_PAUSER);

        emergencyPauseFacet.removeFacet(facetAddress);

        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // ensure that one facet less is registered now
        assertTrue(initialFacets.length == finalFacets.length + 1);
        // ensure that PeripheryRegistryFacet function selector is not associated to any facetAddress
        assertTrue(
            DiamondLoupeFacet(address(emergencyPauseFacet)).facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacet))
                    .registerPeripheryContract
                    .selector
            ) == address(0)
        );

        vm.stopPrank();
    }

    function test_UnauthorizedWalletCannotRemoveFacet() public {
        // get a list of all registered facet addresses
        IDiamondLoupe.Facet[] memory initialFacets = DiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // get PeripheryRegistryFacet address
        address facetAddress = DiamondLoupeFacet(address(emergencyPauseFacet))
            .facetAddress(
                PeripheryRegistryFacet(address(emergencyPauseFacet))
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
        IDiamondLoupe.Facet[] memory finalFacets = DiamondLoupeFacet(
            address(emergencyPauseFacet)
        ).facets();

        // ensure that number of facets remains unchanged
        assertTrue(initialFacets.length == finalFacets.length);
    }
}
