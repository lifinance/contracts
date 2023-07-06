// SPDX-License-Identifier: Unlicensed
pragma solidity 0.8.17;

import { TestBase } from "../utils/TestBase.sol";
import { console } from "../utils/Console.sol";
import { ISGEthVault } from "lifi/Interfaces/ISGEthVault.sol";
import { SGEthVaultWrapper } from "lifi/Periphery/SGEthVaultWrapper.sol";

contract SGEthVaultWrapperTest is TestBase {
    ISGEthVault internal constant sgEthVault =
        ISGEthVault(0x72E2F4830b9E45d52F80aC08CB2bEC0FeF72eD9c);
    SGEthVaultWrapper internal wrapper;

    function setUp() public {
        customBlockNumberForForking = 15020457;
        initTestBase();

        wrapper = new SGEthVaultWrapper(sgEthVault);
    }

    function test_CanDepositEthAndReceiveSgEth() public {
        wrapper.deposit{ value: 1 ether }();
        uint256 sgEthAmount = sgEthVault.balanceOf(address(this));
        assertEq(sgEthAmount, 1 ether);
    }
}
