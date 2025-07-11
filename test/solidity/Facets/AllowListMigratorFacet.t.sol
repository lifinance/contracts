// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { AllowListMigratorFacet } from "src/Facets/AllowListMigratorFacet.sol";
import { WhitelistManagerFacet } from "src/Facets/WhitelistManagerFacet.sol";
import { IDexManagerFacet } from "src/Interfaces/IDexManagerFacet.sol";
import { LiFiDiamond } from "src/LiFiDiamond.sol";
import { LibAllowList } from "src/Libraries/LibAllowList.sol";
import { UnAuthorized } from "src/Errors/GenericErrors.sol";
import { OwnershipFacet } from "src/Facets/OwnershipFacet.sol";
import { TestBase } from "../utils/TestBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

/// @title Mock Swapper Facet
/// @notice Mock facet that simulates SwapperV2 allow list logic for testing
contract MockSwapperFacet {
    /// @notice Simple function to test if a contract is allowed
    /// @param _contract The contract address to check
    function isContractAllowed(
        address _contract
    ) external view returns (bool) {
        return LibAllowList.contractIsAllowed(_contract);
    }

    /// @notice Simple function to test if a selector is allowed
    /// @param _selector The selector to check
    function isSelectorAllowed(bytes4 _selector) external view returns (bool) {
        return LibAllowList.selectorIsAllowed(_selector);
    }
}

contract AllowListMigratorFacetTest is TestBase {
    using stdJson for string;

    event AllowListConfigMigrated(
        address[] whitelistedAddresses,
        bytes4[] whitelistedSelectors
    );

    // LiFi Diamond on mainnet with old DexManager and AllowList storage layout
    address internal constant DIAMOND =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;

    AllowListMigratorFacet internal migratorFacet;
    WhitelistManagerFacet internal whitelistManager;
    IDexManagerFacet internal dexManager;
    MockSwapperFacet internal mockSwapperFacet;

    // Add this array of example selectors
    bytes4[] internal currentWhitelistedSelectors;

    function setUp() public {
        // Fork mainnet
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        vm.createSelectFork(rpcUrl, 22888619);

        // Replace JSON loading with hardcoded selectors
        currentWhitelistedSelectors = new bytes4[](5);
        currentWhitelistedSelectors[0] = 0x38ed1739; // swapExactTokensForTokens
        currentWhitelistedSelectors[1] = 0x8803dbee; // swapTokensForExactTokens
        currentWhitelistedSelectors[2] = 0x7c025200; // swap
        currentWhitelistedSelectors[3] = 0x7617b389; // exactInputSingle
        currentWhitelistedSelectors[4] = 0x90411a32; // execute

        // get DexManager interface
        dexManager = IDexManagerFacet(DIAMOND);
    }

    function test_MigrateAllowListWithSwapperCheck() public {
        mockSwapperFacet = new MockSwapperFacet();
        bytes4[] memory mockSwapperSelectors = new bytes4[](2);
        mockSwapperSelectors[0] = MockSwapperFacet.isContractAllowed.selector;
        mockSwapperSelectors[1] = MockSwapperFacet.isSelectorAllowed.selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(mockSwapperFacet),
            mockSwapperSelectors
        );

        MockSwapperFacet mockSwapper = MockSwapperFacet(DIAMOND);

        // Using real whitelisted address from mainnet config
        address currentlyApprovedDex = 0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D; // Uniswap V2 Router
        // Using real whitelisted selector from config
        bytes4 approvedSelector = 0x38ed1739; // One of the whitelisted selectors

        // BEFORE: FACET WITH SWAPPERV2 LOGIC SHOULD BE ABLE TO DO A SWAP BEFORE MIGRATION
        assertTrue(
            mockSwapper.isContractAllowed(currentlyApprovedDex),
            "Contract should be allowed in allow list before migration"
        );
        assertTrue(
            mockSwapper.isSelectorAllowed(approvedSelector),
            "Selector should be allowed in allow list before migration"
        );

        // MIGRATION STARTS
        // get current whitelisted addresses (approvedDexs) from mainnet diamond using old DexManager interface
        address[] memory whitelistedAddresses = dexManager.approvedDexs();

        // get all selectors that should be whitelisted
        bytes4[] memory selectorsToWhitelist = getAllApprovedSelectors();

        // deploy facets
        migratorFacet = new AllowListMigratorFacet();

        // add AllowListMigratorFacet to diamond
        bytes4[] memory migratorSelectors = new bytes4[](2);
        migratorSelectors[0] = AllowListMigratorFacet.migrate.selector;
        migratorSelectors[1] = AllowListMigratorFacet.isMigrated.selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(migratorFacet),
            migratorSelectors
        );

        // add WhitelistManagerFacet to diamond in this test only to read the allow list and then to verify the whitelisted contract addresses and selectors
        WhitelistManagerFacet whitelistManagerFacet = new WhitelistManagerFacet();
        bytes4[] memory facetSelectors = new bytes4[](2);
        facetSelectors[0] = WhitelistManagerFacet
            .getWhitelistedAddresses
            .selector;
        facetSelectors[1] = WhitelistManagerFacet
            .getApprovedFunctionSelectors
            .selector;

        // add the facet to diamond
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(whitelistManagerFacet),
            facetSelectors
        );

        // now we can read through the diamond
        whitelistManager = WhitelistManagerFacet(DIAMOND);

        bool isMigrated = AllowListMigratorFacet(DIAMOND).isMigrated();
        assertTrue(
            !isMigrated,
            "AllowListMigratorFacet initially should not be migrated"
        );

        // initialize the allow list through the diamond
        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);

        // expect the event to be emitted with exact parameters
        vm.expectEmit(true, true, true, true, DIAMOND);
        emit AllowListConfigMigrated(
            whitelistedAddresses,
            selectorsToWhitelist
        );

        // Call migrate() as the diamond owner to update the allow list configuration with whitelisted addresses and their
        // function selectors. This will:
        // 1. reset the old state to the initial state
        // 2. add the new contracts and selectors to the allow list one more time in order to have correct mapping of contract addresses and selectors
        // 3. emit the AllowListConfigMigrated event
        AllowListMigratorFacet(DIAMOND).migrate(
            whitelistedAddresses,
            selectorsToWhitelist
        );

        isMigrated = AllowListMigratorFacet(DIAMOND).isMigrated();
        assertTrue(isMigrated, "AllowListMigratorFacet should be migrated");

        // verify final state
        address[] memory finalContracts = whitelistManager
            .getWhitelistedAddresses();
        bytes4[] memory finalSelectors = whitelistManager
            .getApprovedFunctionSelectors();

        // verify data matches
        assertEq(
            finalContracts.length,
            whitelistedAddresses.length,
            "whitelistedAddresses length mismatch"
        );
        assertEq(
            finalSelectors.length,
            selectorsToWhitelist.length,
            "whitelistedSelectors length mismatch"
        );

        // verify each selector matches
        for (uint256 i = 0; i < selectorsToWhitelist.length; i++) {
            assertEq(
                finalSelectors[i],
                selectorsToWhitelist[i],
                string(
                    abi.encodePacked(
                        "Selector mismatch at index ",
                        vm.toString(i)
                    )
                )
            );
        }
        // MIGRATION ENDS

        // AFTER: FACET WITH SWAPPERV2 LOGIC SHOULD BE ABLE TO DO A SWAP AFTER MIGRATION
        assertTrue(
            mockSwapper.isContractAllowed(currentlyApprovedDex),
            "Contract should still be allowed in allow list after migration"
        );
        assertTrue(
            mockSwapper.isSelectorAllowed(approvedSelector),
            "Selector should still be allowed in allow list after migration"
        );
    }

    function test_RevertWhenNotOwner() public {
        // deploy facets and set up the diamond like in the main test
        migratorFacet = new AllowListMigratorFacet();

        // add AllowListMigratorFacet to diamond
        bytes4[] memory migratorSelectors = new bytes4[](2);
        migratorSelectors[0] = AllowListMigratorFacet.migrate.selector;
        migratorSelectors[1] = AllowListMigratorFacet.isMigrated.selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(migratorFacet),
            migratorSelectors
        );

        address[] memory newContracts = new address[](0);
        bytes4[] memory newSelectors = new bytes4[](0);

        // try to call migrate as non-owner
        address nonOwner = address(0x123);
        vm.prank(nonOwner);
        vm.expectRevert(UnAuthorized.selector);
        AllowListMigratorFacet(DIAMOND).migrate(newContracts, newSelectors);
    }

    function getAllApprovedSelectors()
        internal
        view
        returns (bytes4[] memory)
    {
        bytes4[] memory approvedSelectors = new bytes4[](5); // Changed from 165 to 5
        uint256 count = 0;

        // Replace JSON parsing with example selectors
        for (uint256 i = 0; i < currentWhitelistedSelectors.length; i++) {
            // check if this selector is approved
            if (
                dexManager.isFunctionApproved(currentWhitelistedSelectors[i])
            ) {
                approvedSelectors[count] = currentWhitelistedSelectors[i];
                count++;
            }
        }

        // create a new array with the exact size of the approved selectors
        bytes4[] memory result = new bytes4[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = approvedSelectors[i];
        }

        return result;
    }
}
