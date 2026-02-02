// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Test } from "forge-std/Test.sol";
import { OFTComposeMsgCodec } from "lifi/Libraries/OFTComposeMsgCodec.sol";

contract OFTComposeMsgCodecHarness {
    function encode(
        uint64 _nonce,
        uint32 _srcEid,
        uint256 _amountLD,
        bytes calldata _composeMsg
    ) external pure returns (bytes memory) {
        bytes memory compose = _composeMsg;
        return OFTComposeMsgCodec.encode(_nonce, _srcEid, _amountLD, compose);
    }

    function nonce(bytes calldata _msg) external pure returns (uint64) {
        return OFTComposeMsgCodec.nonce(_msg);
    }

    function srcEid(bytes calldata _msg) external pure returns (uint32) {
        return OFTComposeMsgCodec.srcEid(_msg);
    }

    function amountLD(bytes calldata _msg) external pure returns (uint256) {
        return OFTComposeMsgCodec.amountLD(_msg);
    }

    function composeFrom(bytes calldata _msg) external pure returns (bytes32) {
        return OFTComposeMsgCodec.composeFrom(_msg);
    }

    function composeMsg(
        bytes calldata _msg
    ) external pure returns (bytes memory) {
        return OFTComposeMsgCodec.composeMsg(_msg);
    }

    function addressToBytes32(address _addr) external pure returns (bytes32) {
        return OFTComposeMsgCodec.addressToBytes32(_addr);
    }

    function bytes32ToAddress(bytes32 _b) external pure returns (address) {
        return OFTComposeMsgCodec.bytes32ToAddress(_b);
    }
}

contract OFTComposeMsgCodecTest is Test {
    OFTComposeMsgCodecHarness internal harness;

    function setUp() public {
        harness = new OFTComposeMsgCodecHarness();
        vm.label(address(harness), "OFTComposeMsgCodecHarness");
    }

    function test_codec_RoundTripDecoding() public {
        uint64 nonce = 1;
        uint32 srcEid = 2;
        uint256 amountLD = 3;
        address composeFromAddr = address(0xBEEF);
        bytes32 composeFrom = harness.addressToBytes32(composeFromAddr);
        bytes memory composePayload = hex"112233";

        bytes memory compose = abi.encodePacked(composeFrom, composePayload);
        bytes memory msg_ = harness.encode(nonce, srcEid, amountLD, compose);

        assertEq(harness.nonce(msg_), nonce);
        assertEq(harness.srcEid(msg_), srcEid);
        assertEq(harness.amountLD(msg_), amountLD);
        assertEq(harness.composeFrom(msg_), composeFrom);
        assertEq(
            keccak256(harness.composeMsg(msg_)),
            keccak256(composePayload)
        );
    }

    function test_codec_AddressConversionsRoundTrip() public {
        address addr = address(0x1234567890AbcdEF1234567890aBcdef12345678);
        bytes32 b = harness.addressToBytes32(addr);

        assertEq(harness.bytes32ToAddress(b), addr);
    }
}
