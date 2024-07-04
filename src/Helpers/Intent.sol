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
    uint256 public amoutOutMin;
    bool public executed = false;

    constructor() {
        implementation = address(this);
    }

    /// @notice Initializes the intent with the given parameters.
    /// @param _initData The init data.
    function init(IIntent.InitData calldata _initData) external {
        bytes32 _salt = keccak256(abi.encode(_initData));
        address predictedAddress = LibClone.predictDeterministicAddress(
            implementation,
            _salt,
            msg.sender
        );
        require(
            address(this) == predictedAddress,
            "Intent: invalid init params"
        );

        intentId = _initData.intentId;
        receiver = _initData.receiver;
        tokenOut = _initData.tokenOut;
        amoutOutMin = _initData.amoutOutMin;
    }

    /// @notice Executes the intent with the given calls.
    /// @param calls The calls to execute.
    function execute(IIntent.Call[] calldata calls) external {
        require(!executed, "Intent: already executed");
        executed = true;

        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, ) = calls[i].to.call{ value: calls[i].value }(
                calls[i].data
            );
            require(success, "Intent: call failed");
        }

        require(
            IERC20(tokenOut).balanceOf(address(this)) >= amoutOutMin,
            "Intent: insufficient output amount"
        );
        if (tokenOut == address(0)) {
            SafeTransferLib.safeTransferAllETH(receiver);
            return;
        }
        SafeTransferLib.safeTransferAll(tokenOut, receiver);
    }

    /// @notice Withdraws all the tokens.
    /// @param tokens The tokens to withdraw.
    function withdrawAll(address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] == address(0)) {
                SafeTransferLib.safeTransferAllETH(receiver);
                continue;
            }
            SafeTransferLib.safeTransferAll(tokens[i], receiver);
        }
    }
}
