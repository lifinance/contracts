// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { ExcessivelySafeCall } from "lifi/Helpers/ExcessivelySafeCall.sol";
import { InvalidCallData } from "src/Errors/GenericErrors.sol";

contract ExcessivelySafeCallHarness {
    using ExcessivelySafeCall for address;

    function callSafe(
        address _target,
        uint16 _maxCopy,
        bytes calldata _calldata
    ) external payable returns (bool, bytes memory) {
        bytes memory data = _calldata;
        return
            ExcessivelySafeCall.excessivelySafeCall(
                _target,
                gasleft(),
                msg.value,
                _maxCopy,
                data
            );
    }

    function staticSafe(
        address _target,
        uint16 _maxCopy,
        bytes calldata _calldata
    ) external view returns (bool, bytes memory) {
        bytes memory data = _calldata;
        return
            ExcessivelySafeCall.excessivelySafeStaticCall(
                _target,
                gasleft(),
                _maxCopy,
                data
            );
    }

    function swapAndReturn(
        bytes4 _newSelector,
        bytes calldata _buf
    ) external pure returns (bytes memory) {
        bytes memory data = _buf;
        ExcessivelySafeCall.swapSelector(_newSelector, data);
        return data;
    }
}

contract ExcessivelySafeCallTarget {
    error CustomError();

    function returnUint(uint256 _value) external pure returns (uint256) {
        return _value;
    }

    function returnBytes(
        uint256 _size,
        bytes1 _fill
    ) external pure returns (bytes memory out) {
        out = new bytes(_size);
        for (uint256 i; i < _size; ) {
            out[i] = _fill;
            unchecked {
                ++i;
            }
        }
    }

    function revertWithCustomError() external pure {
        revert CustomError();
    }

    function revertWithRawBytes(uint256 _size) external pure {
        bytes memory data = new bytes(_size);
        for (uint256 i; i < _size; ) {
            data[i] = bytes1(uint8(i));
            unchecked {
                ++i;
            }
        }

        assembly {
            revert(add(data, 0x20), mload(data))
        }
    }
}

contract ExcessivelySafeCallTest is Test {
    ExcessivelySafeCallHarness internal harness;
    ExcessivelySafeCallTarget internal target;

    function setUp() public {
        harness = new ExcessivelySafeCallHarness();
        target = new ExcessivelySafeCallTarget();

        vm.label(address(harness), "ExcessivelySafeCallHarness");
        vm.label(address(target), "ExcessivelySafeCallTarget");
    }

    function test_excessivelySafeCall_ReturnsFullDataWhenBelowMaxCopy()
        public
    {
        bytes memory callData = abi.encodeWithSelector(
            target.returnUint.selector,
            uint256(123)
        );
        (bool success, bytes memory returnData) = harness.callSafe(
            address(target),
            64,
            callData
        );

        assertTrue(success);
        assertEq(returnData.length, 32);
        assertEq(_loadWord(returnData, 0), bytes32(uint256(123)));
    }

    function test_excessivelySafeCall_CapsReturnData() public {
        bytes memory out = new bytes(200);
        for (uint256 i; i < out.length; ) {
            out[i] = 0x11;
            unchecked {
                ++i;
            }
        }
        bytes memory expected = abi.encode(out);

        bytes memory callData = abi.encodeWithSelector(
            target.returnBytes.selector,
            uint256(200),
            bytes1(0x11)
        );
        (bool success, bytes memory returnData) = harness.callSafe(
            address(target),
            64,
            callData
        );

        assertTrue(success);
        assertEq(returnData.length, 64);
        assertEq(_loadWord(returnData, 0), _loadWord(expected, 0));
        assertEq(_loadWord(returnData, 32), _loadWord(expected, 32));
    }

    function test_excessivelySafeCall_CapsRevertData() public {
        bytes memory callData = abi.encodeWithSelector(
            target.revertWithRawBytes.selector,
            uint256(200)
        );
        (bool success, bytes memory returnData) = harness.callSafe(
            address(target),
            80,
            callData
        );

        assertFalse(success);
        assertEq(returnData.length, 80);
    }

    function test_excessivelySafeCall_ReturnsRevertSelectorWhenBelowMaxCopy()
        public
    {
        bytes memory callData = abi.encodeWithSelector(
            target.revertWithCustomError.selector
        );
        (bool success, bytes memory returnData) = harness.callSafe(
            address(target),
            64,
            callData
        );

        assertFalse(success);
        assertEq(returnData.length, 4);
        assertEq(
            bytes4(_loadWord(returnData, 0)),
            ExcessivelySafeCallTarget.CustomError.selector
        );
    }

    function test_excessivelySafeStaticCall_Works() public {
        bytes memory callData = abi.encodeWithSelector(
            target.returnUint.selector,
            uint256(456)
        );
        (bool success, bytes memory returnData) = harness.staticSafe(
            address(target),
            64,
            callData
        );

        assertTrue(success);
        assertEq(returnData.length, 32);
        assertEq(_loadWord(returnData, 0), bytes32(uint256(456)));
    }

    function test_swapSelector_ReplacesFirst4Bytes() public {
        bytes memory buf = abi.encodeWithSelector(
            bytes4(0xaaaaaaaa),
            uint256(1)
        );
        bytes memory swapped = harness.swapAndReturn(bytes4(0xbbbbbbbb), buf);

        bytes4 selector;
        assembly {
            selector := mload(add(swapped, 0x20))
        }
        assertEq(selector, bytes4(0xbbbbbbbb));
    }

    function testRevert_swapSelector_InvalidCallData() public {
        bytes memory buf = new bytes(3);

        vm.expectRevert(InvalidCallData.selector);

        harness.swapAndReturn(bytes4(0xbbbbbbbb), buf);
    }

    function _loadWord(
        bytes memory _data,
        uint256 _offset
    ) private pure returns (bytes32 word) {
        assembly {
            word := mload(add(add(_data, 0x20), _offset))
        }
    }
}
