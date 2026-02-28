// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { Vm } from "forge-std/Vm.sol";

/// @title TestEIP712
/// @notice Minimal EIP-712 helpers for Foundry tests (domain separator, digest, signing).
abstract contract TestEIP712 {
    Vm internal constant VM =
        Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function _domainSeparator(
        string memory _name,
        string memory _version,
        uint256 _chainId,
        address _verifyingContract
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256(bytes(_name)),
                    keccak256(bytes(_version)),
                    _chainId,
                    _verifyingContract
                )
            );
    }

    function _digest(
        bytes32 _domainSeparatorHash,
        bytes32 _structHash
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked("\x19\x01", _domainSeparatorHash, _structHash)
            );
    }

    function _signDigest(
        uint256 _privateKey,
        bytes32 _digestHash
    ) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = VM.sign(_privateKey, _digestHash);
        return abi.encodePacked(r, s, v);
    }
}
