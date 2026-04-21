// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { OFTComposeMsgCodec } from "lifi/Libraries/OFTComposeMsgCodec.sol";
import { TestBase } from "../utils/TestBase.sol";

contract OFTComposeMsgCodecImplementer {
    function encode(
        uint64 _nonce,
        uint32 _srcEid,
        uint256 _amountLD,
        bytes memory _composeMsg
    ) external pure returns (bytes memory) {
        return OFTComposeMsgCodec.encode(_nonce, _srcEid, _amountLD, _composeMsg);
    }

    function nonce(bytes calldata _msg) external pure returns (uint64) {
        return OFTComposeMsgCodec.nonce(_msg);
    }

    function srcEid(bytes calldata _msg) external pure returns (uint32) {
        return OFTComposeMsgCodec.srcEid(_msg);
    }

    function composeFrom(bytes calldata _msg) external pure returns (bytes32) {
        return OFTComposeMsgCodec.composeFrom(_msg);
    }

    function bytes32ToAddress(bytes32 _b) external pure returns (address) {
        return OFTComposeMsgCodec.bytes32ToAddress(_b);
    }
}

contract OFTComposeMsgCodecTest is TestBase {
    OFTComposeMsgCodecImplementer internal codec;

    // 32 bytes for composeFrom field (address zero-padded to 32 bytes) + 4 bytes payload
    bytes32 internal constant COMPOSE_FROM =
        bytes32(uint256(uint160(0xAaBbccDDAaBbCcdDAABBCcdDAABbCcDdaabBccdd)));
    bytes internal constant COMPOSE_MSG_PAYLOAD = hex"deadbeef";

    function setUp() public {
        codec = new OFTComposeMsgCodecImplementer();
        initTestBase();
    }

    function _buildMsg(
        uint64 _nonce,
        uint32 _srcEid,
        uint256 _amountLD
    ) internal view returns (bytes memory) {
        bytes memory composeMsg = abi.encodePacked(
            COMPOSE_FROM,
            COMPOSE_MSG_PAYLOAD
        );
        return codec.encode(_nonce, _srcEid, _amountLD, composeMsg);
    }

    function test_NonceRoundTrip() public {
        uint64 expected = 42;
        bytes memory msg_ = _buildMsg(expected, 1, 1e18);
        assertEq(codec.nonce(msg_), expected);
    }

    function test_SrcEidRoundTrip() public {
        uint32 expected = 30101;
        bytes memory msg_ = _buildMsg(1, expected, 1e18);
        assertEq(codec.srcEid(msg_), expected);
    }

    function test_ComposeFromRoundTrip() public {
        bytes memory msg_ = _buildMsg(1, 1, 1e18);
        bytes32 result = codec.composeFrom(msg_);
        assertEq(result, COMPOSE_FROM);
    }

    function test_Bytes32ToAddress() public {
        address expected = address(
            0xAaBbccDDAaBbCcdDAABBCcdDAABbCcDdaabBccdd
        );
        bytes32 b = bytes32(uint256(uint160(expected)));
        assertEq(codec.bytes32ToAddress(b), expected);
    }

    function test_Bytes32ToAddressZero() public {
        assertEq(codec.bytes32ToAddress(bytes32(0)), address(0));
    }
}
