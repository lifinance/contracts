// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import { Test } from "forge-std/Test.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";

contract MainContract {
    function topLevelFunction1(address callTo) public {
        (bool success, bytes memory data) = callTo.call(
            abi.encodeWithSignature("callMe()")
        );
        if (!success) {
            LibUtil.revertWith(data);
        }
    }

    function topLevelFunction2(address callTo) public {
        (bool success, bytes memory data) = callTo.call(
            abi.encodeWithSignature("callMeAlso()")
        );
        if (!success) {
            LibUtil.revertWith(data);
        }
    }
}

contract CalledContract {
    error CallMeError();
    error CallMeErrorWithMessage(string message);

    function callMe() external pure {
        revert CallMeError();
    }

    function callMeAlso() external pure {
        revert CallMeErrorWithMessage("Don't call me!");
    }
}

contract LibUtilTest is Test {
    MainContract mainContract;
    CalledContract calledContract;

    function setUp() public {
        mainContract = new MainContract();
        calledContract = new CalledContract();
    }

    error CustomError();
    error CustomErrorWithMessage(string message);

    function test_revert() public {
        bytes memory revertData = abi.encodeWithSelector(CustomError.selector);
        vm.expectRevert(CustomError.selector);
        LibUtil.revertWith(revertData);
    }

    function test_revertWithMessage() public {
        bytes memory revertData = abi.encodeWithSelector(
            CustomErrorWithMessage.selector,
            "Custom error message"
        );
        vm.expectRevert(revertData);
        LibUtil.revertWith(revertData);
    }

    function test_forwardRevertMsgFromExternalCall() public {
        bytes memory revertData = abi.encodeWithSelector(
            CalledContract.CallMeError.selector
        );

        vm.expectRevert(revertData);
        mainContract.topLevelFunction1(address(calledContract));
    }

    function test_forwardRevertMsgWithMessageFromExternalCall() public {
        bytes memory revertData = abi.encodeWithSelector(
            CalledContract.CallMeErrorWithMessage.selector,
            "Don't call me!"
        );
        vm.expectRevert(revertData);
        mainContract.topLevelFunction2(address(calledContract));
    }
}
