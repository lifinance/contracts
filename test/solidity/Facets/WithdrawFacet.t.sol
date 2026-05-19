// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { WithdrawFacet } from "lifi/Facets/WithdrawFacet.sol";
import { UnAuthorized } from "lifi/Errors/GenericErrors.sol";
import { TestBase } from "../utils/TestBase.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WithdrawFacetTest is TestBase {
    WithdrawFacet internal withdrawFacet;

    event LogWithdraw(
        address indexed _assetAddress,
        address _to,
        uint256 amount
    );

    function setUp() public {
        initTestBase();
        withdrawFacet = new WithdrawFacet();

        bytes4[] memory selectors = new bytes4[](2);
        selectors[0] = WithdrawFacet.withdraw.selector;
        selectors[1] = WithdrawFacet.executeCallAndWithdraw.selector;
        addFacet(diamond, address(withdrawFacet), selectors);

        withdrawFacet = WithdrawFacet(address(diamond));
        setFacetAddressInTestBase(address(withdrawFacet), "WithdrawFacet");
    }

    function _fundDiamond(uint256 amount) internal {
        deal(ADDRESS_USDC, address(diamond), amount);
        deal(address(diamond), amount);
    }

    function test_OwnerCanWithdrawERC20() public {
        uint256 amount = 100 * 1e6;
        _fundDiamond(amount);

        vm.startPrank(USER_DIAMOND_OWNER);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LogWithdraw(ADDRESS_USDC, USER_RECEIVER, amount);

        withdrawFacet.withdraw(ADDRESS_USDC, USER_RECEIVER, amount);
        vm.stopPrank();

        assertEq(IERC20(ADDRESS_USDC).balanceOf(USER_RECEIVER), amount);
    }

    function test_OwnerCanWithdrawNative() public {
        uint256 amount = 1 ether;
        _fundDiamond(amount);
        uint256 balanceBefore = USER_RECEIVER.balance;

        vm.startPrank(USER_DIAMOND_OWNER);
        vm.expectEmit(true, true, true, true, address(diamond));
        emit LogWithdraw(address(0), USER_RECEIVER, amount);

        withdrawFacet.withdraw(address(0), USER_RECEIVER, amount);
        vm.stopPrank();

        assertEq(USER_RECEIVER.balance, balanceBefore + amount);
    }

    function test_ZeroAddressRecipientDefaultsToSender() public {
        uint256 amount = 100 * 1e6;
        _fundDiamond(amount);
        uint256 balanceBefore = IERC20(ADDRESS_USDC).balanceOf(USER_DIAMOND_OWNER);

        vm.startPrank(USER_DIAMOND_OWNER);
        withdrawFacet.withdraw(ADDRESS_USDC, address(0), amount);
        vm.stopPrank();

        assertEq(
            IERC20(ADDRESS_USDC).balanceOf(USER_DIAMOND_OWNER),
            balanceBefore + amount
        );
    }

    function testRevert_NonOwnerWithoutAccessCannotWithdraw() public {
        _fundDiamond(100 * 1e6);
        vm.startPrank(USER_SENDER);
        vm.expectRevert(UnAuthorized.selector);
        withdrawFacet.withdraw(ADDRESS_USDC, USER_RECEIVER, 100 * 1e6);
        vm.stopPrank();
    }
}
