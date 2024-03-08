// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { DSTest } from "ds-test/test.sol";
import { console } from "../utils/Console.sol";
import { Vm } from "forge-std/Vm.sol";
import { TokenWrapper } from "lifi/Periphery/TokenWrapper.sol";
import { TestWrappedToken as ERC20 } from "../utils/TestWrappedToken.sol";
import { IERC20 } from "lifi/Libraries/LibAsset.sol";

contract TokenWrapperTest is DSTest {
    Vm internal immutable vm = Vm(HEVM_ADDRESS);
    TokenWrapper private tokenWrapper;
    ERC20 private wrappedToken;

    function setUp() public {
        wrappedToken = new ERC20("TestWrappedToken", "WTST", 18);
        tokenWrapper = new TokenWrapper(address(wrappedToken));
        vm.deal(address(this), 100 ether);
    }

    // Needed to receive ETH
    receive() external payable {}

    function testCanDeposit() public {
        assert(wrappedToken.balanceOf(address(this)) == 0);
        tokenWrapper.deposit{ value: 1 ether }();
        assert(wrappedToken.balanceOf(address(this)) == 1 ether);
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

