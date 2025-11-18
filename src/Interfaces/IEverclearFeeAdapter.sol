// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

/// @title Interface for Everclear Fee Adapter
/// @author LI.FI (https://li.fi)
/// @custom:version 2.0.0
interface IEverclearFeeAdapter {
    struct FeeParams {
        uint256 fee;
        uint256 deadline;
        bytes sig;
    }

    /**
     * @notice The structure of an intent
     * @param initiator The address of the intent initiator
     * @param receiver The address of the intent receiver
     * @param inputAsset The address of the intent asset on origin
     * @param outputAsset The address of the intent asset on destination
     * @param origin The origin chain of the intent
     * @param nonce The nonce of the intent
     * @param timestamp The timestamp of the intent
     * @param ttl The time to live of the intent
     * @param amount The amount of the intent asset normalized to 18 decimals
     * @param amountOutMin The minimum amount out
     * @param destinations The possible destination chains of the intent
     * @param data The data of the intent
     */
    struct Intent {
        bytes32 initiator;
        bytes32 receiver;
        bytes32 inputAsset;
        bytes32 outputAsset;
        uint32 origin;
        uint64 nonce;
        uint48 timestamp;
        uint48 ttl;
        uint256 amount;
        uint256 amountOutMin;
        uint32[] destinations;
        bytes data;
    }

    function newIntent(
        uint32[] memory _destinations,
        bytes32 _receiver,
        address _inputAsset,
        bytes32 _outputAsset,
        uint256 _amount,
        uint256 _amountOutMin,
        uint48 _ttl,
        bytes calldata _data,
        FeeParams calldata _feeParams
    ) external payable returns (bytes32 _intentId, Intent memory _intent);

    function newIntent(
        uint32[] memory _destinations,
        address _receiver,
        address _inputAsset,
        address _outputAsset,
        uint256 _amount,
        uint256 _amountOutMin,
        uint48 _ttl,
        bytes calldata _data,
        FeeParams calldata _feeParams
    ) external payable returns (bytes32 _intentId, Intent memory _intent);

    function updateFeeSigner(address _feeSigner) external;

    function owner() external view returns (address);
}
