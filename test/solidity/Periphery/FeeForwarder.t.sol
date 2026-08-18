// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { FeeForwarder } from "lifi/Periphery/FeeForwarder.sol";
import { InvalidConfig, InvalidReceiver, NullAddrIsNotAnERC20Token, ETHTransferFailed, InsufficientBalance } from "lifi/Errors/GenericErrors.sol";

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

    function setUp() public {
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

    function test_ForwardNativeFeesDoesNotRefundPreExistingBalance() public {
        // Arrange
        uint256 strayBalance = 3 ether;
        vm.deal(address(feeForwarder), strayBalance);

        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether

        uint256 valueSent = AMOUNT_NATIVE_SMALL + AMOUNT_NATIVE_MEDIUM;
        uint256 balanceBefore = USER_SENDER.balance;

        // Act
        vm.prank(USER_SENDER);
        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);

        // Assert - only the unspent part of msg.value comes back, the stray balance stays put
        assertEq(
            USER_RECEIVER.balance,
            RECIPIENT_ETH_BALANCE + AMOUNT_NATIVE_SMALL
        ); // 0.1 ether
        assertEq(USER_SENDER.balance, balanceBefore - AMOUNT_NATIVE_SMALL);
        assertEq(address(feeForwarder).balance, strayBalance);
    }

    function testRevert_ForwardNativeFeesDistributingMoreThanMsgValue()
        public
    {
        // Arrange - a stray balance would cover the shortfall, but the caller did not fund it
        vm.deal(address(feeForwarder), 1 ether);

        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: USER_RECEIVER,
            amount: 1 ether
        });

        // Act & Assert
        vm.prank(USER_SENDER);

        vm.expectRevert(
            abi.encodeWithSelector(
                InsufficientBalance.selector,
                1 ether,
                AMOUNT_NATIVE_MEDIUM
            )
        );

        feeForwarder.forwardNativeFees{ value: AMOUNT_NATIVE_MEDIUM }(
            distributions
        );
    }

    function test_ForwardNativeFeesBlocksReentrantRecipientFromClaimingRefund()
        public
    {
        // Arrange - recipient calls back in and tries to claim everything not yet distributed
        ReentrantFeeRecipient attacker = new ReentrantFeeRecipient(
            feeForwarder
        );
        uint256 valueSent = 5 ether;

        uint256 claimAttempt = valueSent - AMOUNT_NATIVE_SMALL; // 4.9 ether
        attacker.arm({
            _reentryAmount: claimAttempt,
            _reentryValue: 0,
            _reentryWithEmptyArray: false
        });

        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(attacker),
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether

        uint256 balanceBefore = USER_SENDER.balance;

        // Act
        vm.prank(USER_SENDER);
        feeForwarder.forwardNativeFees{ value: valueSent }(distributions);

        // Assert - the callback fired, and it was rejected by the msg.value accounting
        // rather than by some unrelated failure
        assertEq(attacker.reentryAttempts(), 1);
        assertFalse(attacker.reentrySucceeded());
        assertEq(
            attacker.reentryRevertData(),
            abi.encodeWithSelector(
                InsufficientBalance.selector,
                claimAttempt,
                0
            )
        );

        // the recipient only kept its authorized fee
        assertEq(address(attacker).balance, AMOUNT_NATIVE_SMALL); // 0.1 ether
        assertEq(USER_SENDER.balance, balanceBefore - AMOUNT_NATIVE_SMALL);
        assertEq(address(feeForwarder).balance, 0);
    }

    function test_ForwardNativeFeesAllowsHarmlessReentryWhileRefundOutstanding()
        public
    {
        // Arrange - the outer invocation still owes a 4.9 ether refund when the callback
        // fires, but the nested call claims nothing: it funds nothing and distributes nothing
        ReentrantFeeRecipient attacker = new ReentrantFeeRecipient(
            feeForwarder
        );

        attacker.arm({
            _reentryAmount: 0,
            _reentryValue: 0,
            _reentryWithEmptyArray: true
        });

        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(attacker),
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether

        uint256 balanceBefore = USER_SENDER.balance;

        // Act
        vm.prank(USER_SENDER);
        feeForwarder.forwardNativeFees{ value: 5 ether }(distributions);

        // Assert - re-entry is not blocked, it simply has nothing to claim: the nested call
        // succeeds and the outstanding refund still reaches the original caller
        assertEq(attacker.reentryAttempts(), 1);
        assertTrue(attacker.reentrySucceeded());
        assertEq(address(attacker).balance, AMOUNT_NATIVE_SMALL); // 0.1 ether
        assertEq(USER_SENDER.balance, balanceBefore - AMOUNT_NATIVE_SMALL);
        assertEq(address(feeForwarder).balance, 0);
    }

    function test_ForwardNativeFeesAllowsReentrantRecipientToForwardOwnValue()
        public
    {
        // Arrange - the same callback, but the nested call distributes value the recipient
        // funded itself, so it is a legitimate invocation rather than a claim on the parent
        ReentrantFeeRecipient attacker = new ReentrantFeeRecipient(
            feeForwarder
        );
        vm.deal(address(attacker), AMOUNT_NATIVE_MEDIUM);

        attacker.arm({
            _reentryAmount: AMOUNT_NATIVE_MEDIUM,
            _reentryValue: AMOUNT_NATIVE_MEDIUM,
            _reentryWithEmptyArray: false
        });

        FeeForwarder.FeeDistribution[]
            memory distributions = new FeeForwarder.FeeDistribution[](1);
        distributions[0] = FeeForwarder.FeeDistribution({
            recipient: address(attacker),
            amount: AMOUNT_NATIVE_SMALL
        }); // 0.1 ether

        uint256 balanceBefore = USER_SENDER.balance;

        // Act
        vm.prank(USER_SENDER);
        feeForwarder.forwardNativeFees{ value: 5 ether }(distributions);

        // Assert - the nested call succeeded on its own funds and took nothing from the parent
        assertEq(attacker.reentryAttempts(), 1);
        assertTrue(attacker.reentrySucceeded());
        assertEq(
            address(attacker).balance,
            AMOUNT_NATIVE_MEDIUM + AMOUNT_NATIVE_SMALL
        ); // 0.5 + 0.1 ether
        assertEq(USER_SENDER.balance, balanceBefore - AMOUNT_NATIVE_SMALL);
        assertEq(address(feeForwarder).balance, 0);
    }
}

/// @notice Fee recipient that calls back into FeeForwarder from its receive hook
contract ReentrantFeeRecipient {
    FeeForwarder internal immutable FORWARDER;

    uint256 internal reentryAmount;
    uint256 internal reentryValue;
    bool internal reentryWithEmptyArray;
    bool internal armed;

    /// @notice counts callbacks that actually fired, so a test can prove re-entry happened
    ///         rather than passing because the hook was never reached
    uint256 public reentryAttempts;
    bool public reentrySucceeded;
    bytes public reentryRevertData;

    constructor(FeeForwarder _forwarder) {
        FORWARDER = _forwarder;
    }

    function arm(
        uint256 _reentryAmount,
        uint256 _reentryValue,
        bool _reentryWithEmptyArray
    ) external {
        reentryAmount = _reentryAmount;
        reentryValue = _reentryValue;
        reentryWithEmptyArray = _reentryWithEmptyArray;
        armed = true;
    }

    receive() external payable {
        if (armed) _reenter();
    }

    function _reenter() private {
        armed = false;
        ++reentryAttempts;

        FeeForwarder.FeeDistribution[] memory distributions;
        if (reentryWithEmptyArray) {
            distributions = new FeeForwarder.FeeDistribution[](0);
        } else {
            distributions = new FeeForwarder.FeeDistribution[](1);
            distributions[0] = FeeForwarder.FeeDistribution({
                recipient: address(this),
                amount: reentryAmount
            });
        }

        (reentrySucceeded, reentryRevertData) = address(FORWARDER).call{
            value: reentryValue
        }(abi.encodeCall(FeeForwarder.forwardNativeFees, (distributions)));
    }
}
