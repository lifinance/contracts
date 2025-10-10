// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { IEverclearFeeAdapter } from "lifi/Interfaces/IEverclearFeeAdapter.sol";

contract MockEverclearFeeAdapter is IEverclearFeeAdapter {
    using ECDSA for bytes32;

    address public owner;
    address public feeSigner;

    error FeeAdapter_InvalidSignature();
    error FeeAdapter_InvalidDeadline();
    error FeeAdapter_InsufficientNativeFee();
    error FeeAdapter_OnlyOwner();

    constructor(address _owner, address _feeSigner) {
        owner = _owner;
        feeSigner = _feeSigner;
    }

    function updateFeeSigner(address _feeSigner) external override {
        if (msg.sender != owner) revert FeeAdapter_OnlyOwner();
        feeSigner = _feeSigner;
    }

    function newIntent(
        uint32[] memory _destinations,
        bytes32 _receiver,
        address _inputAsset,
        bytes32 _outputAsset,
        uint256 _amount,
        uint24 _maxFee,
        uint48 _ttl,
        bytes calldata _data,
        FeeParams calldata _feeParams
    )
        external
        payable
        override
        returns (bytes32 _intentId, Intent memory _intent)
    {
        return
            _newIntent(
                _destinations,
                _receiver,
                _inputAsset,
                _outputAsset,
                _amount,
                _maxFee,
                _ttl,
                _data,
                _feeParams
            );
    }

    function newIntent(
        uint32[] memory _destinations,
        address _receiver,
        address _inputAsset,
        address _outputAsset,
        uint256 _amount,
        uint24 _maxFee,
        uint48 _ttl,
        bytes calldata _data,
        FeeParams calldata _feeParams
    )
        external
        payable
        override
        returns (bytes32 _intentId, Intent memory _intent)
    {
        return
            _newIntent(
                _destinations,
                bytes32(uint256(uint160(_receiver))),
                _inputAsset,
                bytes32(uint256(uint160(_outputAsset))),
                _amount,
                _maxFee,
                _ttl,
                _data,
                _feeParams
            );
    }

    function _newIntent(
        uint32[] memory _destinations,
        bytes32 _receiver,
        address _inputAsset,
        bytes32 _outputAsset,
        uint256 _amount,
        uint24 _maxFee,
        uint48 _ttl,
        bytes calldata _data,
        FeeParams calldata _feeParams
    ) internal returns (bytes32 _intentId, Intent memory _intent) {
        // Calculate expected native fee from signature data
        uint256 expectedNativeFee = _verifyFeeSignature(
            _feeParams,
            _inputAsset
        );

        // Require that msg.value matches the expected native fee
        if (msg.value != expectedNativeFee) {
            revert FeeAdapter_InsufficientNativeFee();
        }

        // Create mock intent
        _intentId = keccak256(
            abi.encode(
                _receiver,
                _inputAsset,
                _outputAsset,
                _amount,
                block.timestamp
            )
        );

        _intent = Intent({
            initiator: bytes32(uint256(uint160(msg.sender))),
            receiver: _receiver,
            inputAsset: bytes32(uint256(uint160(_inputAsset))),
            outputAsset: _outputAsset,
            maxFee: _maxFee,
            origin: uint32(block.chainid),
            destinations: _destinations,
            nonce: uint64(block.timestamp),
            timestamp: uint48(block.timestamp),
            ttl: _ttl,
            amount: _amount,
            data: _data
        });
    }

    function _verifyFeeSignature(
        FeeParams calldata _feeParams,
        address _inputAsset
    ) internal view returns (uint256 nativeFee) {
        // Verify deadline
        if (block.timestamp > _feeParams.deadline) {
            revert FeeAdapter_InvalidDeadline();
        }

        // The signature should encode the expected native fee, not msg.value
        // We need to try different native fee values to find the one that matches the signature
        uint256 expectedNativeFee = _extractNativeFeeFromSignature(
            _feeParams,
            _inputAsset
        );

        return expectedNativeFee;
    }

    function _extractNativeFeeFromSignature(
        FeeParams calldata _feeParams,
        address _inputAsset
    ) internal view returns (uint256 nativeFee) {
        // Try to recover the native fee from the signature
        // The signature was created with: abi.encode(fee, nativeFee, inputAsset, deadline)

        // Try with msg.value first
        bytes32 messageHash = keccak256(
            abi.encode(
                _feeParams.fee,
                msg.value,
                _inputAsset,
                _feeParams.deadline
            )
        );
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash)
        );
        address recoveredSigner = ethSignedMessageHash.recover(_feeParams.sig);

        if (recoveredSigner == feeSigner) {
            return msg.value;
        }

        // If that doesn't work, the signature was created with a different native fee
        // This means msg.value doesn't match the expected amount
        revert FeeAdapter_InvalidSignature();
    }
}
