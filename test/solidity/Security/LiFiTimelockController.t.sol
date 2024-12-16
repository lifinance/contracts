// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LiFiTimelockController } from "lifi/Security/LiFiTimelockController.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

// Mock contract to simulate a diamond that can be unpaused
contract MockDiamond is Ownable {
    address[] public blacklist;
    bool public unpaused;

    error Unauthorized();

    function unpauseDiamond(address[] calldata _blacklist) external onlyOwner {
        blacklist = _blacklist;
        unpaused = true;
    }
}

contract LiFiTimelockControllerTest is Test {
    LiFiTimelockController public timelock;
    MockDiamond public mockDiamond;

    address public admin = address(0x1);
    address public proposer = address(0x2);
    address public executor = address(0x3);
    address public unauthorized = address(0x4);

    uint256 public constant MIN_DELAY = 1 days;

    // Events
    event RoleGranted(
        bytes32 indexed role,
        address indexed account,
        address indexed sender
    );
    event RoleRevoked(
        bytes32 indexed role,
        address indexed account,
        address indexed sender
    );

    function setUp() public {
        // Setup proposers and executors arrays
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;

        address[] memory executors = new address[](1);
        executors[0] = executor;

        // Deploy contracts
        timelock = new LiFiTimelockController(
            MIN_DELAY,
            proposers,
            executors,
            admin
        );
        mockDiamond = new MockDiamond();

        // Transfer ownership of MockDiamond to timelock
        mockDiamond.transferOwnership(address(timelock));
    }

    function test_Constructor() public {
        // Check roles
        bytes32 adminRole = timelock.TIMELOCK_ADMIN_ROLE();
        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        bytes32 executorRole = timelock.EXECUTOR_ROLE();
        bytes32 cancellerRole = timelock.CANCELLER_ROLE();

        assertTrue(timelock.hasRole(adminRole, admin));
        assertTrue(timelock.hasRole(adminRole, address(timelock)));
        assertTrue(timelock.hasRole(proposerRole, proposer));
        assertTrue(timelock.hasRole(executorRole, executor));
        assertTrue(timelock.hasRole(cancellerRole, proposer));

        // Check delay
        assertEq(timelock.getMinDelay(), MIN_DELAY);
    }

    function test_UnpauseDiamond() public {
        vm.startPrank(admin);

        address[] memory blacklist = new address[](2);
        blacklist[0] = address(0x5);
        blacklist[1] = address(0x6);

        timelock.unpauseDiamond(address(mockDiamond), blacklist);

        assertTrue(mockDiamond.unpaused());
        assertEq(mockDiamond.blacklist(0), blacklist[0]);
        assertEq(mockDiamond.blacklist(1), blacklist[1]);

        vm.stopPrank();
    }

    function test_UnpauseDiamond_DirectCallReverts() public {
        address[] memory blacklist = new address[](1);
        blacklist[0] = address(0x5);

        // Try to call unpauseDiamond directly on the mock diamond
        vm.expectRevert("Ownable: caller is not the owner");
        mockDiamond.unpauseDiamond(blacklist);
    }

    function test_UnpauseDiamond_OnlyTimelockCanCall() public {
        // Verify ownership
        assertEq(mockDiamond.owner(), address(timelock));

        // Try to call as unauthorized user
        vm.startPrank(unauthorized);

        address[] memory blacklist = new address[](1);
        blacklist[0] = address(0x5);

        vm.expectRevert();
        timelock.unpauseDiamond(address(mockDiamond), blacklist);

        vm.stopPrank();
    }

    function test_RoleManagement() public {
        bytes32 adminRole = timelock.TIMELOCK_ADMIN_ROLE();
        address newAdmin = address(0x5);

        // Grant role
        vm.startPrank(admin);
        vm.expectEmit(true, true, true, true);
        emit RoleGranted(adminRole, newAdmin, admin);
        timelock.grantRole(adminRole, newAdmin);
        assertTrue(timelock.hasRole(adminRole, newAdmin));

        // Revoke role
        vm.expectEmit(true, true, true, true);
        emit RoleRevoked(adminRole, newAdmin, admin);
        timelock.revokeRole(adminRole, newAdmin);
        assertFalse(timelock.hasRole(adminRole, newAdmin));

        vm.stopPrank();
    }

    function test_OpenRole() public {
        bytes32 adminRole = timelock.TIMELOCK_ADMIN_ROLE();

        // Grant role to address(0) to make it an open role
        vm.startPrank(admin);
        timelock.grantRole(adminRole, address(0));
        vm.stopPrank();

        // Now unauthorized address should be able to call function
        vm.startPrank(unauthorized);
        address[] memory blacklist = new address[](1);
        blacklist[0] = address(0x5);

        // Should not revert
        timelock.unpauseDiamond(address(mockDiamond), blacklist);
        vm.stopPrank();
    }

    function test_MinDelayEnforcement() public {
        // First grant PROPOSER_ROLE to the proposer if not already granted in constructor
        bytes32 proposerRole = timelock.PROPOSER_ROLE();
        bytes32 executorRole = timelock.EXECUTOR_ROLE();

        vm.startPrank(admin);
        timelock.grantRole(proposerRole, proposer);
        timelock.grantRole(executorRole, executor);
        vm.stopPrank();

        vm.startPrank(proposer);

        bytes memory data = abi.encodeWithSelector(
            timelock.updateDelay.selector,
            2 days
        );

        timelock.schedule(
            address(timelock),
            0,
            data,
            bytes32(0),
            bytes32(0),
            MIN_DELAY
        );

        vm.stopPrank();

        // Switch to executor for execution
        vm.startPrank(executor);

        // Try to execute before delay
        vm.expectRevert("TimelockController: operation is not ready");
        timelock.execute(address(timelock), 0, data, bytes32(0), bytes32(0));

        // Wait for delay
        vm.warp(block.timestamp + MIN_DELAY);

        // Should succeed now
        timelock.execute(address(timelock), 0, data, bytes32(0), bytes32(0));

        assertEq(timelock.getMinDelay(), 2 days);

        vm.stopPrank();
    }

    receive() external payable {}
}
