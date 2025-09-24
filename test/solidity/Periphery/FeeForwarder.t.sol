// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { FeeForwarder } from "lifi/Periphery/FeeForwarder.sol";
import { TestToken as ERC20 } from "../utils/TestToken.sol";
import { InvalidCallData, InvalidReceiver } from "lifi/Errors/GenericErrors.sol";

contract FeeForwarderTest is DSTest {
    // solhint-disable immutable-vars-naming
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    FeeForwarder private feeForwarder;
    ERC20 private feeToken;

    event FeesForwarded(
        address indexed token,
        FeeForwarder.FeeDistribution[] distributions
    );

    function setUp() public {
        feeForwarder = new FeeForwarder(address(this));
        feeToken = new ERC20("FeeToken", "FEE", 18);
        feeToken.mint(address(this), 1000 ether);
        vm.deal(address(this), 100 ether);
        vm.deal(address(0xb33f), 10 ether);
        vm.deal(address(0xb0b), 10 ether);
        vm.deal(address(0xbabe), 10 ether);
    }

    // Needed to receive ETH
    receive() external payable {}

    function test_ForwardERC20FeesTransfersAllDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](2);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 1 ether
        });
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: address(0xb0b),
            amount: 0.5 ether
        });

        uint256 total = distributions[0].amount + distributions[1].amount;

        feeToken.approve(address(feeForwarder), total);

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(feeToken), distributions);

        feeForwarder.forwardERC20Fees(address(feeToken), distributions);

        assertEq(feeToken.balanceOf(address(0xb33f)), 1 ether);
        assertEq(feeToken.balanceOf(address(0xb0b)), 0.5 ether);
        assertEq(feeToken.balanceOf(address(this)), 1000 ether - total);
    }

    function test_ForwardERC20FeesWithSingleDistribution() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 2.5 ether
        });

        feeToken.approve(address(feeForwarder), 2.5 ether);

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(feeToken), distributions);

        feeForwarder.forwardERC20Fees(address(feeToken), distributions);

        assertEq(feeToken.balanceOf(address(0xb33f)), 2.5 ether);
        assertEq(feeToken.balanceOf(address(this)), 1000 ether - 2.5 ether);
    }

    function test_ForwardERC20FeesWithEmptyDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](0);

        // Act & Assert - Empty arrays should not revert and should not emit events (gas optimization)
        feeForwarder.forwardERC20Fees(address(feeToken), distributions);

        // Verify no tokens were transferred
        assertEq(feeToken.balanceOf(address(this)), 1000 ether);
    }

    function test_ForwardNativeFeesForwardsAllDistributionsAndReturnsRemainder()
        public
    {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](2);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 0.75 ether
        });
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: address(0xbabe),
            amount: 0.5 ether
        });

        uint256 total = distributions[0].amount + distributions[1].amount;
        uint256 valueSent = total + 0.25 ether;
        uint256 balanceBefore = address(this).balance;

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);

        assertEq(address(0xb33f).balance, 10.75 ether);
        assertEq(address(0xbabe).balance, 10.5 ether);
        assertEq(address(this).balance, balanceBefore - total);
    }

    function test_ForwardNativeFeesExactValueUsesEntireMsgValue() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb0b),
            amount: 0.8 ether
        });

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: 0.8 ether }(distributions);

        assertEq(address(0xb0b).balance, 10.8 ether);
    }

    function test_ForwardNativeFeesWithEmptyDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](0);
        uint256 balanceBefore = address(this).balance;

        // Act & Assert - Empty arrays should not revert and should not emit events (gas optimization)
        feeForwarder.forwardNativeFees{ value: 1 ether }(distributions);

        // Verify all native tokens are refunded
        assertEq(address(this).balance, balanceBefore);
    }

    function test_ForwardNativeFeesWithMultipleDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](3);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 0.1 ether
        });
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: address(0xb0b),
            amount: 0.2 ether
        });
        distributions[2] = FeeForwarder.FeeDistribution({
            recipient: address(0xbabe),
            amount: 0.3 ether
        });

        uint256 total = 0.6 ether;
        uint256 valueSent = total + 0.1 ether; // Extra for remainder
        uint256 balanceBefore = address(this).balance;

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);

        assertEq(address(0xb33f).balance, 10.1 ether);
        assertEq(address(0xb0b).balance, 10.2 ether);
        assertEq(address(0xbabe).balance, 10.3 ether);
        assertEq(address(this).balance, balanceBefore - total);
    }

    function testRevert_ForwardNativeFeesInsufficientValue() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb0b),
            amount: 1 ether
        });

        // Act & Assert - Transaction will revert due to insufficient funds when trying to transfer ETH
        vm.expectRevert();
        feeForwarder.forwardNativeFees{ value: 0.5 ether }(distributions);
    }

    function testRevert_ForwardERC20FeesWhenNativeTokenProvided() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb0b),
            amount: 1 ether
        });

        // Act & Assert - Native token transfers will fail naturally when trying to transfer, saving gas
        vm.expectRevert();
        feeForwarder.forwardERC20Fees(address(0), distributions);
    }

    function testRevert_ForwardERC20FeesWithZeroAmount() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 0
        });

        // Act & Assert
        vm.expectRevert(InvalidCallData.selector);
        feeForwarder.forwardERC20Fees(address(feeToken), distributions);
    }

    function testRevert_ForwardNativeFeesWithZeroAmount() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 0
        });

        // Act & Assert
        vm.expectRevert(InvalidCallData.selector);
        feeForwarder.forwardNativeFees{ value: 1 ether }(distributions);
    }

    function testRevert_ForwardERC20FeesWithZeroRecipient() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0),
            amount: 1 ether
        });

        // Act & Assert
        vm.expectRevert(InvalidReceiver.selector);
        feeForwarder.forwardERC20Fees(address(feeToken), distributions);
    }

    function testRevert_ForwardNativeFeesWithZeroRecipient() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0),
            amount: 1 ether
        });

        // Act & Assert
        vm.expectRevert(InvalidReceiver.selector);
        feeForwarder.forwardNativeFees{ value: 1 ether }(distributions);
    }

    function test_ForwardNativeFeesWithExactRemainder() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](2);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 0.3 ether
        });
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: address(0xb0b),
            amount: 0.7 ether
        });

        uint256 total = 1 ether;
        uint256 balanceBefore = address(this).balance;

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: total }(distributions);

        assertEq(address(0xb33f).balance, 10.3 ether);
        assertEq(address(0xb0b).balance, 10.7 ether);
        assertEq(address(this).balance, balanceBefore - total);
    }

    function test_ForwardNativeFeesWithLargeRemainder() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 0.1 ether
        });

        uint256 valueSent = 5 ether; // Much larger than needed
        uint256 balanceBefore = address(this).balance;

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);

        assertEq(address(0xb33f).balance, 10.1 ether);
        assertEq(address(this).balance, balanceBefore - 0.1 ether); // Only 0.1 ether used
    }

    function test_ForwardERC20FeesWithLargeDistribution() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0xb33f),
            amount: 500 ether
        });

        feeToken.approve(address(feeForwarder), 500 ether);

        // Act & Assert
        vm.expectEmit(true, false, false, true, address(feeForwarder));
        emit FeesForwarded(address(feeToken), distributions);

        feeForwarder.forwardERC20Fees(address(feeToken), distributions);

        assertEq(feeToken.balanceOf(address(0xb33f)), 500 ether);
        assertEq(feeToken.balanceOf(address(this)), 500 ether);
    }
}
