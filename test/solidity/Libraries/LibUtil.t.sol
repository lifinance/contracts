// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { InvalidCallData } from "lifi/Errors/GenericErrors.sol";

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

contract LibUtilImplementer {
    function revertWith(bytes memory reason) public pure {
        LibUtil.revertWith(reason);
    }

    function isZeroAddress(address addr) public pure returns (bool) {
        return LibUtil.isZeroAddress(addr);
    }

    function convertAddressToBytes32(
        address addr
    ) public pure returns (bytes32) {
        return LibUtil.convertAddressToBytes32(addr);
    }

    function convertBytes32ToAddress(
        bytes32 addr
    ) public pure returns (address) {
        return LibUtil.convertBytes32ToAddress(addr);
    }

    function convertAddressToBytes(
        address addr
    ) public pure returns (bytes memory) {
        return LibUtil.convertAddressToBytes(addr);
    }

    function convertBytesToAddress(
        bytes memory addr
    ) public pure returns (address) {
        return LibUtil.convertBytesToAddress(addr);
    }
}

contract LibUtilTest is Test {
    MainContract internal mainContract;
    CalledContract internal calledContract;
    LibUtilImplementer internal implementer;
    address internal testAddress;

    function setUp() public {
        mainContract = new MainContract();
        calledContract = new CalledContract();
        implementer = new LibUtilImplementer();
        testAddress = address(0x1234);
    }

    error CustomError();
    error CustomErrorWithMessage(string message);

    function test_revert() public {
        bytes memory revertData = abi.encodeWithSelector(CustomError.selector);
        vm.expectRevert(CustomError.selector);

        implementer.revertWith(revertData);
    }

    function test_revertWithMessage() public {
        bytes memory revertData = abi.encodeWithSelector(
            CustomErrorWithMessage.selector,
            "Custom error message"
        );
        vm.expectRevert(revertData);
        implementer.revertWith(revertData);
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

    function test_ReturnsTrueIfCalledWithZeroAddress() public view {
        bool result = implementer.isZeroAddress(address(0));

        assert(result == true);
    }

    function test_ReturnsFalseIfCalledWithNonZeroAddress() public view {
        bool result = implementer.isZeroAddress(address(1234));

        assert(result == false);

        result = implementer.isZeroAddress(address(implementer));

        assert(result == false);
    }

    function test_AddressToBytes32ConversionRoundtrip() public view {
        // convert initial address to bytes32
        bytes32 converted = implementer.convertAddressToBytes32(testAddress);

        // convert bytes32 result back to address
        address addressConverted = implementer.convertBytes32ToAddress(
            converted
        );

        // compare results
        assert(testAddress == addressConverted);
    }

    function test_Bytes32ToAddressConversionRoundtrip() public view {
        // [pre-commit-checker: not a secret]
        bytes32 testAddrBytes32 = hex"0000000000000000000000000000000000000000000000000000000000001234";

        // convert initial address to address
        address converted = implementer.convertBytes32ToAddress(
            testAddrBytes32
        );

        // make sure converted address matches with initial test address
        assert(converted == testAddress);

        // convert address result back to bytes32
        bytes32 addressBytes32Converted = implementer.convertAddressToBytes32(
            converted
        );

        // compare results
        assert(testAddrBytes32 == addressBytes32Converted);
    }

    function test_AddressToBytesMemoryConversionRoundtrip() public view {
        // convert initial address to bytes memory
        bytes memory converted = implementer.convertAddressToBytes(
            testAddress
        );

        // convert bytes memory result back to address
        address addressConverted = implementer.convertBytesToAddress(
            converted
        );

        // compare results
        assert(testAddress == addressConverted);
    }

    function test_BytesMemoryToAddressConversionRoundtrip() public view {
        bytes memory testAddrBytes = abi.encodePacked(testAddress);

        // convert initial bytes memory address to address
        address converted = implementer.convertBytesToAddress(testAddrBytes);

        // make sure converted address matches with initial test address
        assert(converted == testAddress);

        // convert address result back to bytes32
        bytes memory addressBytesConverted = implementer.convertAddressToBytes(
            converted
        );

        // compare results
        assert(
            keccak256(abi.encode(testAddrBytes)) ==
                keccak256(abi.encode(addressBytesConverted))
        );
    }

    function testRevert_WhenAddressIsShorterThan20Bytes() public {
        bytes memory shortAddress = hex"1234567890";

        vm.expectRevert(InvalidCallData.selector);

        implementer.convertBytesToAddress(shortAddress);
    }
}
