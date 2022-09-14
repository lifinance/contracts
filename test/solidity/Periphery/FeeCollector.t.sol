// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.16;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { FeeCollector } from "lifi/Periphery/FeeCollector.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";

contract FeeCollectorTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    FeeCollector private feeCollector;
    ERC20 private feeToken;

    function setUp() public {
        feeCollector = new FeeCollector(address(this));
        feeToken = new ERC20("TestToken", "TST", 18);
        feeToken.mint(address(this), 100_000 ether);
        vm.deal(address(0xb33f), 100 ether);
        vm.deal(address(0xb0b), 100 ether);
    }

    // Needed to receive ETH
    receive() external payable {}

    function testCanCollectTokenFees() public {
        // Arrange
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;

        // Act
        feeToken.approve(address(feeCollector), integratorFee + lifiFee);
        feeCollector.collectTokenFees(address(feeToken), integratorFee, lifiFee, address(0xb33f));

        // Assert
        assert(feeToken.balanceOf(address(feeCollector)) == integratorFee + lifiFee);
        assert(feeCollector.getTokenBalance(address(0xb33f), address(feeToken)) == integratorFee);
        assert(feeCollector.getLifiTokenBalance(address(feeToken)) == lifiFee);
    }

    function testCanCollectNativeFees() public {
        // Arrange
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;

        // Act
        feeCollector.collectNativeFees{ value: integratorFee + lifiFee }(integratorFee, lifiFee, address(0xb33f));

        // Assert
        assert(address(feeCollector).balance == integratorFee + lifiFee);
        assert(feeCollector.getTokenBalance(address(0xb33f), address(0)) == integratorFee);
        assert(feeCollector.getLifiTokenBalance(address(0)) == lifiFee);
    }

    function testCanWithdrawIntegratorFees() public {
        // Arrange
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;
        feeToken.approve(address(feeCollector), integratorFee + lifiFee);
        feeCollector.collectTokenFees(address(feeToken), integratorFee, lifiFee, address(0xb33f));

        // Act
        vm.prank(address(0xb0b));
        feeCollector.withdrawIntegratorFees(address(feeToken));
        vm.prank(address(0xb33f));
        feeCollector.withdrawIntegratorFees(address(feeToken));

        // Assert
        assert(feeToken.balanceOf(address(0xb33f)) == 1 ether);
        assert(feeToken.balanceOf(address(0xb0b)) == 0 ether);
        assert(feeToken.balanceOf(address(feeCollector)) == 0.015 ether);
    }

    function testCanWithdrawLifiFees() public {
        // Arrange
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;
        feeToken.approve(address(feeCollector), integratorFee + lifiFee);
        feeCollector.collectTokenFees(address(feeToken), integratorFee, lifiFee, address(0xb33f));
        uint256 startingBalance = feeToken.balanceOf(address(this));

        // Act
        feeCollector.withdrawLifiFees(address(feeToken));

        // Assert
        assert(feeToken.balanceOf(address(this)) == 0.015 ether + startingBalance);
        assert(feeToken.balanceOf(address(feeCollector)) == 1 ether);
    }

    function testCanBatchWithdrawIntegratorFees() public {
        // Arrange
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;
        feeToken.approve(address(feeCollector), integratorFee + lifiFee);
        feeCollector.collectTokenFees(address(feeToken), integratorFee, lifiFee, address(0xb33f));
        feeCollector.collectNativeFees{ value: integratorFee + lifiFee }(integratorFee, lifiFee, address(0xb33f));

        // Act
        address[] memory tokens = new address[](2);
        tokens[0] = address(feeToken);
        tokens[1] = address(0);
        uint256 preBalanceB33f = address(0xb33f).balance;
        vm.prank(address(0xb33f));
        feeCollector.batchWithdrawIntegratorFees(tokens);

        // Assert
        assert(feeToken.balanceOf(address(0xb33f)) == 1 ether);
        assert(feeToken.balanceOf(address(feeCollector)) == 0.015 ether);
        assert(address(0xb33f).balance == 1 ether + preBalanceB33f);
        assert(address(feeCollector).balance == 0.015 ether);
    }

    function testCanBatchWithdrawLifiFees() public {
        // Arrange
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;
        feeToken.approve(address(feeCollector), integratorFee + lifiFee);
        feeCollector.collectTokenFees(address(feeToken), integratorFee, lifiFee, address(0xb33f));
        feeCollector.collectNativeFees{ value: integratorFee + lifiFee }(integratorFee, lifiFee, address(0xb33f));
        uint256 startingTokenBalance = feeToken.balanceOf(address(this));
        uint256 startingETHBalance = address(this).balance;

        // Act
        address[] memory tokens = new address[](2);
        tokens[0] = address(feeToken);
        tokens[1] = address(0);
        feeCollector.batchWithdrawLifiFees(tokens);

        // Assert
        assert(feeToken.balanceOf(address(this)) == 0.015 ether + startingTokenBalance);
        assert(address(this).balance == 0.015 ether + startingETHBalance);
        assert(address(feeCollector).balance == 1 ether);
        assert(feeToken.balanceOf(address(feeCollector)) == 1 ether);
    }

    function testFailWhenNonOwnerAttemptsToWithdrawLifiFees() public {
        // Arrange
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;
        feeToken.approve(address(feeCollector), integratorFee + lifiFee);
        feeCollector.collectTokenFees(address(feeToken), integratorFee, lifiFee, address(0xb33f));

        // Act
        vm.prank(address(0xb33f));
        feeCollector.withdrawLifiFees(address(feeToken));
    }

    function testFailWhenNonOwnerAttemptsToBatchWithdrawLifiFees() public {
        // Arranges.newOwner
        uint256 integratorFee = 1 ether;
        uint256 lifiFee = 0.015 ether;
        feeToken.approve(address(feeCollector), integratorFee + lifiFee);
        feeCollector.collectTokenFees(address(feeToken), integratorFee, lifiFee, address(0xb33f));
        feeCollector.collectNativeFees{ value: integratorFee + lifiFee }(integratorFee, lifiFee, address(0xb33f));

        // Act
        address[] memory tokens = new address[](2);
        tokens[0] = address(feeToken);
        tokens[1] = address(0);
        vm.prank(address(0xb33f));
        feeCollector.batchWithdrawLifiFees(tokens);
    }

    function testOwnerCanTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        feeCollector.transferOwnership(newOwner);
        assert(feeCollector.owner() != newOwner);
        vm.startPrank(newOwner);
        feeCollector.confirmOwnershipTransfer();
        assert(feeCollector.owner() == newOwner);
        vm.stopPrank();
    }

    function testFailNonOwnerCanTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        assert(feeCollector.owner() != newOwner);
        vm.prank(newOwner);
        feeCollector.transferOwnership(newOwner);
    }

    function testFailOnwershipTransferToNullAddr() public {
        address newOwner = address(0x0);
        feeCollector.transferOwnership(newOwner);
    }

    function testFailOwnerCanConfirmPendingOwnershipTransfer() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        feeCollector.transferOwnership(newOwner);
        feeCollector.confirmOwnershipTransfer();
    }

    function testFailOwnershipTransferToSelf() public {
        address newOwner = address(this);
        feeCollector.transferOwnership(newOwner);
    }
}
