// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { LibClone } from "solady/utils/LibClone.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { IIntent } from "../Interfaces/IIntent.sol";

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

/// @title Intent
/// @author LI.FI (https://li.fi)
/// @notice Intent contract that can execute arbitrary calls.
/// @custom:version 1.0.0
contract Intent {
    bytes32 public intentId;
    bytes32 public salt;
    address public receiver;
    address public immutable implementation;
    address public factory;
    address public tokenOut;
    uint256 public amountOutMin;
    bool public executed = false;

    error Unauthorized();
    error AlreadyExecuted();
    error InvalidParams();
    error ExecutionFailed();
    error InsufficientOutputAmount();

    constructor() {
        implementation = address(this);
    }

    /// @notice Initializes the intent with the given parameters.
    /// @param _initData The init data.
    function init(IIntent.InitData calldata _initData) external {
        salt = keccak256(abi.encode(_initData));
        factory = msg.sender;
        address predictedAddress = LibClone.predictDeterministicAddress(
            implementation,
            salt,
            msg.sender
        );
        if (address(this) != predictedAddress) {
            revert InvalidParams();
        }

        intentId = _initData.intentId;
        receiver = _initData.receiver;
        tokenOut = _initData.tokenOut;
        amountOutMin = _initData.amountOutMin;
    }

    /// @notice Executes the intent with the given calls.
    /// @param calls The calls to execute.
    function execute(IIntent.Call[] calldata calls) external {
        if (msg.sender != factory) {
            revert Unauthorized();
        }
        if (executed) {
            revert AlreadyExecuted();
        }
        executed = true;

        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, ) = calls[i].to.call{ value: calls[i].value }(
                calls[i].data
            );
            if (!success) {
                revert ExecutionFailed();
            }
        }

        if (IERC20(tokenOut).balanceOf(address(this)) < amountOutMin) {
            revert InsufficientOutputAmount();
        }
        if (tokenOut == address(0)) {
            SafeTransferLib.safeTransferAllETH(receiver);
            return;
        }
        SafeTransferLib.safeTransferAll(tokenOut, receiver);
    }

    /// @notice Withdraws all the tokens.
    /// @param tokens The tokens to withdraw.
    function withdrawAll(address[] calldata tokens) external {
        if (msg.sender != factory) {
            revert Unauthorized();
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) {
                SafeTransferLib.safeTransferAllETH(receiver);
                continue;
            }
            SafeTransferLib.safeTransferAll(tokens[i], receiver);
        }
    }
}
