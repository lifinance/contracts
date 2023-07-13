// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { ServiceFeeCollector } from "lifi/Periphery/ServiceFeeCollector.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";

contract ServiceFeeCollectorTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    ServiceFeeCollector private feeCollector;
    ERC20 private feeToken;

    error UnAuthorized();
    error NoNullOwner();
    error NotPendingOwner();
    error NewOwnerMustNotBeSelf();

    function setUp() public {
        feeCollector = new ServiceFeeCollector(address(this));
        feeToken = new ERC20("TestToken", "TST", 18);
        feeToken.mint(address(this), 100_000 ether);
        vm.deal(address(0xb33f), 100 ether);
        vm.deal(address(0xb0b), 100 ether);
    }

    // Needed to receive ETH
    receive() external payable {}

    function testCanCollectTokenGasFees() public {
        // Arrange
        uint256 fee = 0.015 ether;

        // Act
        feeToken.approve(address(feeCollector), fee);
        feeCollector.collectTokenGasFees(
            address(feeToken),
            fee,
            address(0xb33f)
        );

        // Assert
        assert(feeToken.balanceOf(address(feeCollector)) == fee);
    }

    function testCanCollectNativeGasFees() public {
        // Arrange
        uint256 fee = 0.015 ether;

        // Act
        feeCollector.collectNativeGasFees{ value: fee }(fee, address(0xb33f));

        // Assert
        assert(address(feeCollector).balance == fee);
    }

    function testCanCollectTokenInsuranceFees() public {
        // Arrange
        uint256 fee = 0.015 ether;

        // Act
        feeToken.approve(address(feeCollector), fee);
        feeCollector.collectTokenInsuranceFees(
            address(feeToken),
            fee,
            address(0xb33f)
        );

        // Assert
        assert(feeToken.balanceOf(address(feeCollector)) == fee);
    }

    function testCanCollectNativeInsuranceFees() public {
        // Arrange
        uint256 fee = 0.015 ether;

        // Act
        feeCollector.collectNativeInsuranceFees{ value: fee }(
            fee,
            address(0xb33f)
        );

        // Assert
        assert(address(feeCollector).balance == fee);
    }

    function testCanWithdrawFees() public {
        // Arrange
        uint256 fee = 0.015 ether;
        feeToken.approve(address(feeCollector), fee);
        feeCollector.collectTokenGasFees(
            address(feeToken),
            fee,
            address(0xb33f)
        );
        uint256 startingBalance = feeToken.balanceOf(address(this));

        // Act
        feeCollector.withdrawFees(address(feeToken));

        // Assert
        assert(
            feeToken.balanceOf(address(this)) == 0.015 ether + startingBalance
        );
        assert(feeToken.balanceOf(address(feeCollector)) == 0);
    }

    function testCanWithdrawNativeFees() public {
        // Arrange
        uint256 fee = 0.015 ether;
        feeCollector.collectNativeInsuranceFees{ value: fee }(
            fee,
            address(0xb33f)
        );
        uint256 startingBalance = address(this).balance;

        // Act
        feeCollector.withdrawFees(address(0));

        // Assert
        assert(address(this).balance == 0.015 ether + startingBalance);
        assert(address(feeCollector).balance == 0);
    }

    function testCanBatchWithdrawGasFees() public {
        // Arrange
        uint256 fee = 0.015 ether;
        feeToken.approve(address(feeCollector), fee);
        feeCollector.collectTokenGasFees(
            address(feeToken),
            fee,
            address(0xb33f)
        );
        feeCollector.collectNativeGasFees{ value: fee }(fee, address(0xb33f));
        uint256 startingTokenBalance = feeToken.balanceOf(address(this));
        uint256 startingETHBalance = address(this).balance;

        // Act
        address[] memory tokens = new address[](2);
        tokens[0] = address(feeToken);
        tokens[1] = address(0);
        feeCollector.batchWithdrawFees(tokens);

        // Assert
        assert(
            feeToken.balanceOf(address(this)) ==
                0.015 ether + startingTokenBalance
        );
        assert(address(this).balance == 0.015 ether + startingETHBalance);
        assert(address(feeCollector).balance == 0);
    }

    function testRevertsWhenNonOwnerAttemptsToWithdrawFees() public {
        // Arrange
        uint256 fee = 0.015 ether;
        feeToken.approve(address(feeCollector), fee);
        feeCollector.collectTokenGasFees(
            address(feeToken),
            fee,
            address(0xb33f)
        );

        // Act
        vm.prank(address(0xb33f));
        vm.expectRevert(UnAuthorized.selector);
        feeCollector.withdrawFees(address(feeToken));
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

    function testRevertsWhenNonOwnerCanTransferOwnership() public {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        assert(feeCollector.owner() != newOwner);
        vm.prank(newOwner);
        vm.expectRevert(UnAuthorized.selector);
        feeCollector.transferOwnership(newOwner);
    }

    function testRevertsWhenOnwershipTransferToNullAddr() public {
        address newOwner = address(0x0);
        vm.expectRevert(NoNullOwner.selector);
        feeCollector.transferOwnership(newOwner);
    }

    function testRevertsWhenOwnerAttemptsToConfirmPendingOwnershipTransfer()
        public
    {
        address newOwner = address(0x1234567890123456789012345678901234567890);
        feeCollector.transferOwnership(newOwner);
        vm.expectRevert(NotPendingOwner.selector);
        feeCollector.confirmOwnershipTransfer();
    }

    function testRevertsOnOwnershipTransferToSelf() public {
        address newOwner = address(this);
        vm.expectRevert(NewOwnerMustNotBeSelf.selector);
        feeCollector.transferOwnership(newOwner);
    }
}
