// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { TokenWrapper } from "lifi/Periphery/TokenWrapper.sol";
import { TestWrappedToken as ERC20 } from "../utils/TestWrappedToken.sol";
import { TestWrappedConverter } from "../utils/TestWrappedConverter.sol";
import { TestBasicToken } from "../utils/TestBasicToken.sol";
import { TestConverterWithDecimals } from "../utils/TestConverterWithDecimals.sol";

contract TokenWrapperTest is DSTest {
    // solhint-disable immutable-vars-naming
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    TokenWrapper private tokenWrapper;
    ERC20 private wrappedToken;

    // Converter test variables
    TokenWrapper private tokenWrapperWithConverter;
    TestBasicToken private basicToken;
    TestWrappedConverter private converter;

    // Decimal converter test variables
    TokenWrapper private tokenWrapperWithDecimalConverter;
    TestBasicToken private token6Decimals;
    TestConverterWithDecimals private decimalConverter;

    error ETHTransferFailed();

    function setUp() public {
        wrappedToken = new ERC20("TestWrappedToken", "WTST", 18);
        tokenWrapper = new TokenWrapper(
            address(wrappedToken),
            address(0),
            address(this)
        );
        vm.deal(address(this), 100 ether);

        // Setup converter test scenario
        basicToken = new TestBasicToken("BasicToken", "BASIC", 18);
        converter = new TestWrappedConverter(address(basicToken));
        tokenWrapperWithConverter = new TokenWrapper(
            address(basicToken),
            address(converter),
            address(this)
        );

        // Fund the converter with basic tokens and ETH for testing
        basicToken.mint(address(converter), 100 ether);
        vm.deal(address(converter), 100 ether);

        // Setup decimal converter test scenario (simulates GasUSDT0Converter)
        token6Decimals = new TestBasicToken("USDT", "USDT", 6);
        decimalConverter = new TestConverterWithDecimals(
            address(token6Decimals)
        );
        tokenWrapperWithDecimalConverter = new TokenWrapper(
            address(token6Decimals),
            address(decimalConverter),
            address(this)
        );

        // Fund the decimal converter with 6-decimal tokens and ETH
        token6Decimals.mint(address(decimalConverter), 100_000_000); // 100 USDT (6 decimals)
        vm.deal(address(decimalConverter), 100 ether);
    }

    // Needed to receive ETH
    receive() external payable {}

    function test_CanDeposit() public {
        assert(wrappedToken.balanceOf(address(this)) == 0);
        tokenWrapper.deposit{ value: 1 ether }();
        assert(wrappedToken.balanceOf(address(this)) == 1 ether);
    }

    function test_CanWithdrawToken() public {
        // Send some ETH to the contract
        (bool success, ) = address(tokenWrapper).call{ value: 1 ether }("");
        if (!success) revert ETHTransferFailed();

        uint256 initialBalance = address(this).balance;
        tokenWrapper.withdrawToken(
            address(0),
            payable(address(this)),
            1 ether
        );
        assertEq(address(this).balance - initialBalance, 1 ether);
    }

    function test_CanWithdraw() public {
        uint256 initialBalance = address(this).balance;
        vm.deal(address(wrappedToken), 100 ether);
        wrappedToken.mint(address(this), 1 ether);
        wrappedToken.approve(address(tokenWrapper), 1 ether);
        tokenWrapper.withdraw();
        assert(address(this).balance - initialBalance == 1 ether);
    }

    // ========== CONVERTER TESTS ==========

    function test_CanDepositWithConverter() public {
        // Initial state: user has no basic tokens
        assertEq(basicToken.balanceOf(address(this)), 0);

        // User deposits ETH through TokenWrapper
        tokenWrapperWithConverter.deposit{ value: 1 ether }();

        // User should now have basic tokens
        assertEq(basicToken.balanceOf(address(this)), 1 ether);
    }

    function test_CanWithdrawWithConverter() public {
        uint256 initialBalance = address(this).balance;

        // Give user some basic tokens
        basicToken.mint(address(this), 1 ether);

        // Approve TokenWrapper to spend basic tokens
        basicToken.approve(address(tokenWrapperWithConverter), 1 ether);

        // User withdraws through TokenWrapper
        tokenWrapperWithConverter.withdraw();

        // User should have received ETH
        assertEq(address(this).balance - initialBalance, 1 ether);

        // User should have no basic tokens left
        assertEq(basicToken.balanceOf(address(this)), 0);
    }

    function test_ConverterReceivesApproval() public {
        // Give user some basic tokens
        basicToken.mint(address(this), 1 ether);

        // Approve TokenWrapper
        basicToken.approve(address(tokenWrapperWithConverter), 1 ether);

        // Check that converter has no allowance before withdraw
        assertEq(
            basicToken.allowance(
                address(tokenWrapperWithConverter),
                address(converter)
            ),
            0
        );

        // Withdraw
        tokenWrapperWithConverter.withdraw();

        // After withdraw, the approval should have been set
        // (TokenWrapper approves converter to pull tokens)
        assertEq(
            basicToken.allowance(
                address(tokenWrapperWithConverter),
                address(converter)
            ),
            type(uint256).max
        );
    }

    function test_CanDepositWithDecimalConverter() public {
        // Initial state: user has no 6-decimal tokens
        assertEq(token6Decimals.balanceOf(address(this)), 0);

        // User deposits 1 ETH (18 decimals)
        // Should receive 1 USDT (6 decimals) after conversion
        tokenWrapperWithDecimalConverter.deposit{ value: 1 ether }();

        // User should now have 1 USDT (1e6, not 1e18)
        assertEq(token6Decimals.balanceOf(address(this)), 1_000_000);
    }

    function test_CanWithdrawWithDecimalConverter() public {
        uint256 initialBalance = address(this).balance;

        // Give user 1 USDT (6 decimals)
        token6Decimals.mint(address(this), 1_000_000);

        // Approve TokenWrapper to spend tokens
        token6Decimals.approve(
            address(tokenWrapperWithDecimalConverter),
            1_000_000
        );

        // User withdraws 1 USDT (6 decimals)
        tokenWrapperWithDecimalConverter.withdraw();

        // User should have received 1 ETH (18 decimals) after conversion
        assertEq(address(this).balance - initialBalance, 1 ether);

        // User should have no tokens left
        assertEq(token6Decimals.balanceOf(address(this)), 0);
    }

    function test_DecimalConverterRoundTrip() public {
        // Start with 5 ETH
        uint256 depositAmount = 5 ether;

        // Deposit 5 ETH, should receive 5 USDT (6 decimals)
        tokenWrapperWithDecimalConverter.deposit{ value: depositAmount }();
        assertEq(token6Decimals.balanceOf(address(this)), 5_000_000);

        // Approve and withdraw all USDT
        token6Decimals.approve(
            address(tokenWrapperWithDecimalConverter),
            5_000_000
        );

        uint256 balanceBefore = address(this).balance;
        tokenWrapperWithDecimalConverter.withdraw();

        // Should receive back 5 ETH
        assertEq(address(this).balance - balanceBefore, depositAmount);
    }
}
