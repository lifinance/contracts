// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { LibBytes } from "lifi/Libraries/LibBytes.sol";

contract LibBytesHarness {
    function slice(
        bytes calldata _bytes,
        uint256 _start,
        uint256 _length
    ) external pure returns (bytes memory) {
        bytes memory data = _bytes;
        return LibBytes.slice(data, _start, _length);
    }

    function toAddress(
        bytes calldata _bytes,
        uint256 _start
    ) external pure returns (address) {
        bytes memory data = _bytes;
        return LibBytes.toAddress(data, _start);
    }

    function toHexString(
        uint256 _value,
        uint256 _length
    ) external pure returns (string memory) {
        return LibBytes.toHexString(_value, _length);
    }
}

contract LibBytesTest is Test {
    LibBytesHarness internal harness;

    function setUp() public {
        harness = new LibBytesHarness();
        vm.label(address(harness), "LibBytesHarness");
    }

    function test_slice_CopiesBytes() public {
        bytes memory input = hex"0102030405";
        bytes memory out = harness.slice(input, 1, 3);

        assertEq(out.length, 3);
        assertEq(keccak256(out), keccak256(hex"020304"));
    }

    function test_slice_ZeroLengthReturnsEmptyBytes() public {
        bytes memory input = hex"0102030405";
        bytes memory out = harness.slice(input, 2, 0);

        assertEq(out.length, 0);
        assertEq(keccak256(out), keccak256(bytes("")));
    }

    function testRevert_slice_OutOfBounds() public {
        bytes memory input = hex"0102030405";

        vm.expectRevert(LibBytes.SliceOutOfBounds.selector);

        harness.slice(input, 4, 2);
    }

    function test_toAddress_ReadsAddressAtStart() public {
        address addr = address(0x1234567890AbcdEF1234567890aBcdef12345678);
        bytes memory input = abi.encodePacked(addr);

        assertEq(harness.toAddress(input, 0), addr);
    }

    function test_toAddress_ReadsAddressAtOffset() public {
        address addr = address(0x9999999999999999999999999999999999999999);
        bytes memory input = abi.encodePacked(uint256(1), addr, uint256(2));

        assertEq(harness.toAddress(input, 32), addr);
    }

    function testRevert_toAddress_OutOfBounds() public {
        bytes memory input = new bytes(19);

        vm.expectRevert(LibBytes.AddressOutOfBounds.selector);

        harness.toAddress(input, 0);
    }

    function test_toHexString_PadsToLength() public {
        assertEq(harness.toHexString(uint256(0x1234), 2), "0x1234");
        assertEq(harness.toHexString(uint256(0x1), 2), "0x0001");
    }

    function testRevert_toHexString_LengthInsufficient() public {
        vm.expectRevert("Strings: hex length insufficient");

        harness.toHexString(uint256(0x1234), 1);
    }
}
