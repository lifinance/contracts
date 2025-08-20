// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { WithdrawablePeriphery } from "lifi/Helpers/WithdrawablePeriphery.sol";

import { TestBase } from "../utils/TestBase.sol";
import { NonETHReceiver } from "../utils/TestHelpers.sol";

contract TestContract is WithdrawablePeriphery {
    constructor(address _owner) WithdrawablePeriphery(_owner) {}
}

contract WithdrawablePeripheryTest is TestBase {
    WithdrawablePeriphery internal withdrawable;

    event TokensWithdrawn(
        address assetId,
        address payable receiver,
        uint256 amount
    );

    error UnAuthorized();

    function setUp() public {
        initTestBase();

        // deploy contract
        withdrawable = new TestContract(USER_DIAMOND_OWNER);

        // fund contract with native and ERC20
        deal(
            ADDRESS_USDC,
            address(withdrawable),
            100_000 * 10 ** usdc.decimals()
        );
        deal(address(withdrawable), 1 ether);
    }

    function test_AllowsOwnerToWithdrawNative() public {
        uint256 withdrawAmount = 0.1 ether;

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(withdrawable));
        emit TokensWithdrawn(
            address(0),
            payable(USER_RECEIVER),
            withdrawAmount
        );

        withdrawable.withdrawToken(
            address(0),
            payable(USER_RECEIVER),
            withdrawAmount
        );
    }

    function test_AllowsOwnerToWithdrawERC20() public {
        uint256 withdrawAmount = 10 * 10 ** usdc.decimals();
        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectEmit(true, true, true, true, address(withdrawable));
        emit TokensWithdrawn(
            ADDRESS_USDC,
            payable(USER_RECEIVER),
            withdrawAmount
        );

        withdrawable.withdrawToken(
            ADDRESS_USDC,
            payable(USER_RECEIVER),
            withdrawAmount
        );
    }

    function testRevert_FailsIfNonOwnerTriesToWithdrawNative() public {
        uint256 withdrawAmount = 0.1 ether;

        vm.startPrank(USER_SENDER);

        vm.expectRevert(UnAuthorized.selector);

        withdrawable.withdrawToken(
            address(0),
            payable(USER_RECEIVER),
            withdrawAmount
        );
    }

    function testRevert_FailsIfNonOwnerTriesToWithdrawERC20() public {
        uint256 withdrawAmount = 10 * 10 ** usdc.decimals();
        vm.startPrank(USER_SENDER);

        vm.expectRevert(UnAuthorized.selector);

        withdrawable.withdrawToken(
            ADDRESS_USDC,
            payable(USER_RECEIVER),
            withdrawAmount
        );
    }

    function testRevert_FailsIfNativeTokenTransferFails() public {
        uint256 withdrawAmount = 0.1 ether;

        address nonETHReceiver = address(new NonETHReceiver());

        vm.startPrank(USER_DIAMOND_OWNER);

        vm.expectRevert();

        withdrawable.withdrawToken(
            address(0),
            payable(nonETHReceiver),
            withdrawAmount
        );
    }
}
