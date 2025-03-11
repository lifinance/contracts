// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.17;

import { DSTest } from "ds-test/test.sol";
import { Vm } from "forge-std/Vm.sol";
import { TokenWrapper } from "lifi/Periphery/TokenWrapper.sol";
import { TestWrappedToken as ERC20 } from "../utils/TestWrappedToken.sol";

contract TokenWrapperTest is DSTest {
    // solhint-disable immutable-vars-naming
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    TokenWrapper private tokenWrapper;
    ERC20 private wrappedToken;

    error ETHTransferFailed();

    function setUp() public {
        wrappedToken = new ERC20("TestWrappedToken", "WTST", 18);
        tokenWrapper = new TokenWrapper(address(wrappedToken), address(this));
        vm.deal(address(this), 100 ether);
    }

    // Needed to receive ETH
    receive() external payable {}

    function testCanDeposit() public {
        assert(wrappedToken.balanceOf(address(this)) == 0);
        tokenWrapper.deposit{ value: 1 ether }();
        assert(wrappedToken.balanceOf(address(this)) == 1 ether);
    }

    function testCanWithdrawToken() public {
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

    function testCanWithdraw() public {
        uint256 initialBalance = address(this).balance;
        vm.deal(address(wrappedToken), 100 ether);
        wrappedToken.mint(address(this), 1 ether);
        wrappedToken.approve(address(tokenWrapper), 1 ether);
        tokenWrapper.withdraw();
        assert(address(this).balance - initialBalance == 1 ether);
    }
}
