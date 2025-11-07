// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { FeeForwarder } from "lifi/Periphery/FeeForwarder.sol";
import { InvalidConfig, InvalidReceiver, NullAddrIsNotAnERC20Token, ETHTransferFailed } from "lifi/Errors/GenericErrors.sol";

contract FeeForwarderTest is TestBase {
    FeeForwarder private feeForwarder;

    // Test amounts
    uint256 internal constant RECIPIENT_ETH_BALANCE = 10 ether;
    uint256 internal initialTokenBalance;

    // Fixed distribution amounts for consistency
    uint256 internal amountERC20Small; // 1 USDC
    uint256 internal amountERC20Medium; // 0.5 USDC
    uint256 internal amountERC20Large; // 2.5 USDC

    // Fixed native token amounts for consistency
    uint256 internal constant AMOUNT_NATIVE_SMALL = 0.1 ether;
    uint256 internal constant AMOUNT_NATIVE_MEDIUM = 0.5 ether;
    uint256 internal constant AMOUNT_NATIVE_LARGE = 0.8 ether;

    event FeesForwarded(
        address indexed token,
        FeeForwarder.FeeDistribution[] distributions
    );

    function setUp() public virtual override {
        // Initialize TestBase which sets up USER_SENDER, WITHDRAW_WALLET, etc.
        initTestBase();

        // Use TestBase's WITHDRAW_WALLET
        feeForwarder = new FeeForwarder(WITHDRAW_WALLET);

        // Initialize test amounts using usdc.decimals()
        initialTokenBalance = 100_000 * 10 ** usdc.decimals(); // 100,000 USDC

        // Initialize fixed distribution amounts
        amountERC20Small = 1 * 10 ** usdc.decimals(); // 1 USDC
        amountERC20Medium = 5 * 10 ** (usdc.decimals() - 1); // 0.5 USDC
        amountERC20Large = 25 * 10 ** (usdc.decimals() - 1); // 2.5 USDC

        // Fund test recipient addresses
        vm.deal(USER_RECEIVER, RECIPIENT_ETH_BALANCE);
        vm.deal(USER_REFUND, RECIPIENT_ETH_BALANCE);
        vm.deal(USER_PAUSER, RECIPIENT_ETH_BALANCE);
    }

    // Needed to receive ETH
    receive() external payable {}

    function test_ConstructorWithValidOwner() public {
        // Arrange
        address validOwner = WITHDRAW_WALLET;

        // Act
        FeeForwarder newFeeForwarder = new FeeForwarder(validOwner);

        // Assert
        assertEq(newFeeForwarder.owner(), validOwner);
    }

    function testRevert_ConstructorWithZeroOwner() public {
        // Act & Assert
        vm.expectRevert(InvalidConfig.selector);
        new FeeForwarder(address(0));
    }

    function test_ForwardERC20FeesTransfersAllDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](2);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: amountERC20Small
        }); // 1 USDC
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: amountERC20Medium
        }); // 0.5 USDC

        uint256 total = distributions[0].amount + distributions[1].amount;

        // Act & Assert
        vm.startPrank(USER_SENDER);

        usdc.approve(address(feeForwarder), total);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(usdc), distributions);

        feeForwarder.forwardERC20Fees(address(usdc), distributions);
        vm.stopPrank();

        assertEq(usdc.balanceOf(USER_RECEIVER), amountERC20Small); // 1 USDC
        assertEq(usdc.balanceOf(USER_REFUND), amountERC20Medium); // 0.5 USDC
        assertEq(usdc.balanceOf(USER_SENDER), initialTokenBalance - total);
    }

    function test_ForwardERC20FeesWithSingleDistribution() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: amountERC20Large
        }); // 2.5 USDC

        // Act & Assert
        vm.startPrank(USER_SENDER);

        usdc.approve(address(feeForwarder), amountERC20Large); // 2.5 USDC
        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(usdc), distributions);

        feeForwarder.forwardERC20Fees(address(usdc), distributions);
        vm.stopPrank();

        assertEq(usdc.balanceOf(USER_RECEIVER), amountERC20Large); // 2.5 USDC
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialTokenBalance - amountERC20Large
        ); // 2.5 USDC
    }

    function test_ForwardERC20FeesWithEmptyDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](0);

        // Act & Assert - Empty arrays should not revert but will still emit events
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(usdc), distributions);

        feeForwarder.forwardERC20Fees(address(usdc), distributions);
        vm.stopPrank();

        // Verify no tokens were transferred
        assertEq(usdc.balanceOf(USER_SENDER), initialTokenBalance);
    }

    function test_ForwardERC20FeesWithMixedDistributionsIncludingZero()
        public
    {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](3);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: amountERC20Small
        }); // 1 USDC
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: 0
        }); // 0 USDC
        distributions[2] = FeeForwarder.FeeDistribution({
            recipient: USER_PAUSER,
            amount: amountERC20Medium
        }); // 0.5 USDC

        uint256 total = amountERC20Small + amountERC20Medium; // Only non-zero amounts

        // Act & Assert
        vm.startPrank(USER_SENDER);

        usdc.approve(address(feeForwarder), total);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(usdc), distributions);

        feeForwarder.forwardERC20Fees(address(usdc), distributions);
        vm.stopPrank();

        // Verify only non-zero amounts were transferred
        assertEq(usdc.balanceOf(USER_RECEIVER), amountERC20Small); // 1 USDC
        assertEq(usdc.balanceOf(USER_REFUND), 0); // 0 USDC
        assertEq(usdc.balanceOf(USER_PAUSER), amountERC20Medium); // 0.5 USDC
        assertEq(usdc.balanceOf(USER_SENDER), initialTokenBalance - total);
    }

    function test_ForwardNativeFeesForwardsAllDistributionsAndReturnsRemainder()
        public
    {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](2);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: AMOUNT_NATIVE_LARGE
        }); // 0.8 ether
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: USER_PAUSER,
            amount: AMOUNT_NATIVE_MEDIUM
        }); // 0.5 ether

        uint256 total = distributions[0].amount + distributions[1].amount;
        uint256 valueSent = total + 0.25 ether;
        uint256 balanceBefore = USER_SENDER.balance;

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);
        vm.stopPrank();

        assertEq(
            USER_RECEIVER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_LARGE
        ); // 0.8 ether
        assertEq(
            USER_PAUSER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_MEDIUM
        ); // 0.5 ether
        assertEq(USER_SENDER.balance, balanceBefore - total);
    }

    function test_ForwardNativeFeesExactValueUsesEntireMsgValue() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: AMOUNT_NATIVE_LARGE
        }); // 0.8 ether

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: AMOUNT_NATIVE_LARGE }(
            distributions
        );
        vm.stopPrank();

        assertEq(
            USER_REFUND.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_LARGE
        ); // 0.8 ether
    }

    function test_ForwardNativeFeesWithEmptyDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](0);
        uint256 balanceBefore = USER_SENDER.balance;

        // Act & Assert - Empty arrays should not revert but will still emit events
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: 1 ether }(distributions);
        vm.stopPrank();

        // Verify all native tokens are refunded
        assertEq(USER_SENDER.balance, balanceBefore);
    }

    function test_ForwardNativeFeesWithMixedDistributionsIncludingZero()
        public
    {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](3);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: 0
        }); // 0 ether
        distributions[2] = FeeForwarder.FeeDistribution({
            recipient: USER_PAUSER,
            amount: AMOUNT_NATIVE_MEDIUM
        }); // 0.5 ether

        uint256 total = AMOUNT_NATIVE_SMALL + AMOUNT_NATIVE_MEDIUM; // Only non-zero amounts
        uint256 valueSent = total + AMOUNT_NATIVE_SMALL; // Extra for remainder
        uint256 balanceBefore = USER_SENDER.balance;

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);
        vm.stopPrank();

        // Verify only non-zero amounts were transferred
        assertEq(
            USER_RECEIVER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_SMALL
        ); // 0.1 ether
        assertEq(USER_REFUND.balance, RECIPIENT_ETH_BALANCE); // 0 ether (no change)
        assertEq(
            USER_PAUSER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_MEDIUM
        ); // 0.5 ether
        assertEq(USER_SENDER.balance, balanceBefore - total);
    }

    function test_ForwardNativeFeesWithMultipleDistributions() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](3);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: AMOUNT_NATIVE_MEDIUM
        }); // 0.5 ether
        distributions[2] = FeeForwarder.FeeDistribution({
            recipient: USER_PAUSER,
            amount: AMOUNT_NATIVE_LARGE
        }); // 0.8 ether

        uint256 total = distributions[0].amount +
            distributions[1].amount +
            distributions[2].amount;
        uint256 valueSent = total + AMOUNT_NATIVE_SMALL; // Extra for remainder
        uint256 balanceBefore = USER_SENDER.balance;

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);
        vm.stopPrank();

        assertEq(
            USER_RECEIVER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_SMALL
        ); // 0.1 ether
        assertEq(
            USER_REFUND.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_MEDIUM
        ); // 0.5 ether
        assertEq(
            USER_PAUSER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_LARGE
        ); // 0.8 ether
        assertEq(USER_SENDER.balance, balanceBefore - total);
    }

    function testRevert_ForwardNativeFeesInsufficientValue() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: 1 ether
        });

        // Act & Assert - Transaction will revert due to insufficient funds when trying to transfer ETH
        vm.startPrank(USER_SENDER);

        vm.expectRevert(ETHTransferFailed.selector);
        feeForwarder.forwardNativeFees{ value: AMOUNT_NATIVE_MEDIUM }(
            distributions
        );
        vm.stopPrank();
    }

    function testRevert_ForwardERC20FeesWhenNativeTokenProvided() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: amountERC20Small
        }); // 1 USDC

        // Act & Assert - Native token transfers will fail naturally when trying to transfer, saving gas
        vm.startPrank(USER_SENDER);

        vm.expectRevert(NullAddrIsNotAnERC20Token.selector);
        feeForwarder.forwardERC20Fees(address(0), distributions);
        vm.stopPrank();
    }

    function test_ForwardERC20FeesWithZeroAmount() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: 0
        }); // 0 USDC

        uint256 balanceBefore = usdc.balanceOf(USER_RECEIVER);

        // Act & Assert - Zero amount transfers succeed but transfer nothing (gas optimization)
        vm.startPrank(USER_SENDER);

        feeForwarder.forwardERC20Fees(address(usdc), distributions);
        vm.stopPrank();

        // Verify no tokens were transferred
        assertEq(usdc.balanceOf(USER_RECEIVER), balanceBefore);
    }

    function test_ForwardNativeFeesWithZeroAmount() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: 0
        });

        uint256 balanceBefore = USER_RECEIVER.balance;
        uint256 callerBalanceBefore = USER_SENDER.balance;

        // Act & Assert - Zero amount transfers succeed but transfer nothing (gas optimization)
        vm.startPrank(USER_SENDER);

        feeForwarder.forwardNativeFees{ value: 1 ether }(distributions);
        vm.stopPrank();

        // Verify no native tokens were transferred
        assertEq(USER_RECEIVER.balance, balanceBefore);
        // Verify all sent value is refunded
        assertEq(USER_SENDER.balance, callerBalanceBefore);
    }

    function testRevert_ForwardERC20FeesWithZeroRecipient() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(0),
            amount: amountERC20Small
        }); // 1 USDC

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectRevert(InvalidReceiver.selector);
        feeForwarder.forwardERC20Fees(address(usdc), distributions);
        vm.stopPrank();
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
        vm.startPrank(USER_SENDER);

        vm.expectRevert(InvalidReceiver.selector);
        feeForwarder.forwardNativeFees{ value: 1 ether }(distributions);
        vm.stopPrank();
    }

    function test_ForwardNativeFeesWithExactRemainder() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](2);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: AMOUNT_NATIVE_MEDIUM
        }); // 0.5 ether

        uint256 total = AMOUNT_NATIVE_SMALL + AMOUNT_NATIVE_MEDIUM; // 0.6 ether
        uint256 balanceBefore = USER_SENDER.balance;

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: total }(distributions);
        vm.stopPrank();

        assertEq(
            USER_RECEIVER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_SMALL
        ); // 0.1 ether
        assertEq(
            USER_REFUND.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_MEDIUM
        ); // 0.5 ether
        assertEq(USER_SENDER.balance, balanceBefore - total);
    }

    function test_ForwardNativeFeesWithLargeRemainder() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether

        uint256 valueSent = 5 ether; // Much larger than needed
        uint256 balanceBefore = USER_SENDER.balance;

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);
        vm.stopPrank();

        assertEq(
            USER_RECEIVER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_SMALL
        ); // 0.1 ether
        assertEq(USER_SENDER.balance, balanceBefore - AMOUNT_NATIVE_SMALL); // Only 0.1 ether used
    }

    function test_ForwardERC20FeesWithLargeDistribution() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: 500 * 10 ** usdc.decimals()
        }); // 500 USDC

        // Act & Assert
        vm.startPrank(USER_SENDER);

        usdc.approve(address(feeForwarder), 500 * 10 ** usdc.decimals()); // 500 USDC
        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(usdc), distributions);

        feeForwarder.forwardERC20Fees(address(usdc), distributions);
        vm.stopPrank();

        assertEq(usdc.balanceOf(USER_RECEIVER), 500 * 10 ** usdc.decimals()); // 500 USDC
        assertEq(
            usdc.balanceOf(USER_SENDER),
            initialTokenBalance - 500 * 10 ** usdc.decimals()
        ); // 500 USDC
    }

    function test_ForwardNativeFeesWithAdvancedEventVerification() public {
        // Arrange
        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](2);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: AMOUNT_NATIVE_MEDIUM
        }); // 0.5 ether
        distributions[1] = FeeForwarder.FeeDistribution({
            recipient: USER_REFUND,
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether

        uint256 total = distributions[0].amount + distributions[1].amount;
        uint256 valueSent = total + AMOUNT_NATIVE_MEDIUM; // Extra for remainder

        // Act & Assert
        vm.startPrank(USER_SENDER);

        vm.expectEmit(true, true, true, true, address(feeForwarder));
        emit FeesForwarded(address(0), distributions);

        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);
        vm.stopPrank();

        // Verify recipient balances
        assertEq(
            USER_RECEIVER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_MEDIUM
        ); // 0.5 ether
        assertEq(
            USER_REFUND.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_SMALL
        ); // 0.1 ether
    }
}
