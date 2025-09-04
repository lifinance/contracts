// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { LiFiDiamond } from "lifi/LiFiDiamond.sol";
import { CommonDiamondTest } from "./utils/CommonDiamondTest.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";

contract LiFiDiamondTest is CommonDiamondTest {
    function setUp() public virtual override {
        super.setUp();
        // Call createDiamond to get a fully configured diamond with all facets
        createDiamond(USER_DIAMOND_OWNER, USER_PAUSER);
    }

    /// @notice Test that LiFiDiamond can be deployed without errors
    function test_DeploysWithoutErrors() public override {
        LiFiDiamond testDiamond = new LiFiDiamond(
            USER_DIAMOND_OWNER,
            address(diamondCutFacet)
        );
        assertTrue(
            address(testDiamond) != address(0),
            "Diamond should be deployed"
        );
    }

    /// @notice Test that LiFiDiamond reverts when constructed with zero address owner
    function testRevert_LiFiDiamondConstructedWithZeroAddressOwner() public {
        vm.expectRevert(InvalidConfig.selector);
        new LiFiDiamond(
            address(0), // This should trigger InvalidConfig
            address(diamondCutFacet)
        );
    }
}
