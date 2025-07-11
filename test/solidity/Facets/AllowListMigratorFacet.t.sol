// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { AllowListMigratorFacet } from "src/Facets/AllowListMigratorFacet.sol";
import { WhitelistManagerFacet } from "src/Facets/WhitelistManagerFacet.sol";
import { IDexManagerFacet } from "src/Interfaces/IDexManagerFacet.sol";
import { LiFiDiamond } from "src/LiFiDiamond.sol";
import { LibDiamond } from "src/Libraries/LibDiamond.sol";
import { UnAuthorized } from "src/Errors/GenericErrors.sol";
import { OwnershipFacet } from "src/Facets/OwnershipFacet.sol";
import { TestBase } from "../utils/TestBase.sol";
import { stdJson } from "forge-std/StdJson.sol";

contract AllowListMigratorFacetTest is TestBase {
    using stdJson for string;

    // Event declaration
    event AllowListConfigMigrated(
        address[] whitelistedAddresses,
        bytes4[] whitelistedSelectors
    );

    // LiFi Diamond on mainnet
    address internal constant DIAMOND =
        0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE;

    // Test data files
    string internal constant WHITELISTED_SELECTORS =
        "config/whitelistedSelectors.json";

    // Facets
    AllowListMigratorFacet internal migratorFacet;
    WhitelistManagerFacet internal whitelistManager;
    IDexManagerFacet internal dexManager;

    // Test data
    string internal jsonSelectors;

    function setUp() public {
        // Fork mainnet
        string memory rpcUrl = vm.envString("ETH_NODE_URI_MAINNET");
        vm.createSelectFork(rpcUrl, 22888619);

        // Load selectors data
        jsonSelectors = vm.readFile(WHITELISTED_SELECTORS);

        // Get DexManager interface
        dexManager = IDexManagerFacet(DIAMOND);

        // Start recording logs for event verification
        vm.recordLogs();
    }

    function test_MigrateAllowList() public {
        // Get current whitelisted addresses from mainnet diamond using old DexManager interface
        address[] memory whitelistedAddresses = dexManager.approvedDexs();

        // Get all approved selectors from mainnet
        bytes4[] memory whitelistedSelectors = getAllApprovedSelectors();

        // Deploy facets
        migratorFacet = new AllowListMigratorFacet();

        // Add AllowListMigratorFacet to diamond
        bytes4[] memory migratorSelectors = new bytes4[](2);
        migratorSelectors[0] = AllowListMigratorFacet.migrate.selector;
        migratorSelectors[1] = AllowListMigratorFacet.isMigrated.selector;
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(migratorFacet),
            migratorSelectors
        );

        // Add WhitelistManagerFacet to diamond
        WhitelistManagerFacet whitelistManagerFacet = new WhitelistManagerFacet();
        bytes4[] memory facetSelectors = new bytes4[](2);
        facetSelectors[0] = WhitelistManagerFacet
            .getWhitelistedAddresses
            .selector;
        facetSelectors[1] = WhitelistManagerFacet
            .getApprovedFunctionSelectors
            .selector;

        // Add the facet to diamond
        addFacet(
            LiFiDiamond(payable(DIAMOND)),
            address(whitelistManagerFacet),
            facetSelectors
        );

        // Now we can read through the diamond
        whitelistManager = WhitelistManagerFacet(DIAMOND);

        bool isMigrated = AllowListMigratorFacet(DIAMOND).isMigrated();
        assertTrue(
            !isMigrated,
            "AllowListMigratorFacet should not be migrated"
        );

        // Initialize the allow list through the diamond
        address owner = OwnershipFacet(DIAMOND).owner();
        vm.prank(owner);

        // Expect the event to be emitted with exact parameters
        vm.expectEmit(true, true, true, true, DIAMOND);
        emit AllowListConfigMigrated(
            whitelistedAddresses,
            whitelistedSelectors
        );

        // Call the function that should emit the event
        AllowListMigratorFacet(DIAMOND).migrate(
            whitelistedAddresses,
            whitelistedSelectors
        );

        isMigrated = AllowListMigratorFacet(DIAMOND).isMigrated();
        assertTrue(isMigrated, "AllowListMigratorFacet should be migrated");

        // Verify final state
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
            whitelistedSelectors.length,
            "whitelistedSelectors length mismatch"
        );

        // verify each selector matches
        for (uint256 i = 0; i < whitelistedSelectors.length; i++) {
            assertEq(
                finalSelectors[i],
                whitelistedSelectors[i],
                string(
                    abi.encodePacked(
                        "Selector mismatch at index ",
                        vm.toString(i)
                    )
                )
            );
        }
    }

    function getAllApprovedSelectors() internal returns (bytes4[] memory) {
        // Create a dynamic array to store approved selectors
        bytes4[] memory approvedSelectors = new bytes4[](165); // We expect around 165 selectors
        uint256 count = 0;

        // First get all selectors from the JSON file
        // File has exactly 165 selectors
        for (uint256 i = 0; i < 165; i++) {
            string memory key = string(
                abi.encodePacked(".selectors[", vm.toString(i), "]")
            );
            string memory selectorString = jsonSelectors.readString(key);
            bytes4 selector = bytes4(vm.parseBytes(selectorString));

            // Check if this selector is approved
            if (dexManager.isFunctionApproved(selector)) {
                approvedSelectors[count] = selector;
                count++;
            }
        }

        // Create a new array with the exact size
        bytes4[] memory result = new bytes4[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = approvedSelectors[i];
        }

        return result;
    }

    function test_RevertWhenNotOwner() public {
        address[] memory newContracts = new address[](0);
        bytes4[] memory newSelectors = new bytes4[](0);

        // Prepare diamond cut
        LibDiamond.FacetCut[] memory cut = new LibDiamond.FacetCut[](1);
        bytes4[] memory selectors = new bytes4[](1);
        selectors[0] = migratorFacet.migrate.selector;

        cut[0] = LibDiamond.FacetCut({
            facetAddress: address(migratorFacet),
            action: LibDiamond.FacetCutAction.Add,
            functionSelectors: selectors
        });

        bytes memory initData = abi.encodeWithSelector(
            AllowListMigratorFacet.migrate.selector,
            newContracts,
            newSelectors
        );

        vm.expectRevert(UnAuthorized.selector);
        LibDiamond.diamondCut(cut, address(migratorFacet), initData);
    }
}
