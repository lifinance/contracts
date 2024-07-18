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
    /// Storage ///

    struct IntentConfig {
        bytes32 intentId;
        bytes32 salt;
        address receiver;
        address factory;
        address tokenOut;
        uint256 amountOutMin;
        uint256 deadline;
        uint8 executed;
    }

    address public immutable implementation;
    IntentConfig public config;

    /// Events ///
    event IntentExecuted(
        bytes32 indexed intentId,
        address receiver,
        address tokenOut,
        uint256 amountOut
    );

    /// Errors ///

    error Unauthorized();
    error AlreadyExecuted();
    error InvalidParams();
    error ExecutionFailed();
    error InsufficientOutputAmount();

    /// Constructor ///

    constructor() {
        implementation = address(this);
    }

    /// External Methods ///

    /// @notice Initializes the intent with the given parameters.
    /// @param _initData The init data.
    function init(IIntent.InitData calldata _initData) external {
        config.salt = keccak256(abi.encode(_initData));
        config.factory = msg.sender;
        address predictedAddress = LibClone.predictDeterministicAddress(
            implementation,
            config.salt,
            msg.sender
        );
        if (address(this) != predictedAddress) {
            revert InvalidParams();
        }

        config.intentId = _initData.intentId;
        config.receiver = _initData.receiver;
        config.tokenOut = _initData.tokenOut;
        config.amountOutMin = _initData.amountOutMin;
    }

    /// @notice Executes the intent with the given calls.
    /// @param calls The calls to execute.
    function execute(IIntent.Call[] calldata calls) external {
        if (msg.sender != config.factory) {
            revert Unauthorized();
        }
        if (config.executed > 0) {
            revert AlreadyExecuted();
        }
        config.executed = 1; // Set as executed

        for (uint256 i = 0; i < calls.length; i++) {
            (bool success, ) = calls[i].to.call{ value: calls[i].value }(
                calls[i].data
            );
            if (!success) {
                revert ExecutionFailed();
            }
        }

        bool isNative = config.tokenOut == address(0);

        if (isNative) {
            // Handle native output
            if (address(this).balance < config.amountOutMin) {
                revert InsufficientOutputAmount();
            }
            SafeTransferLib.safeTransferAllETH(config.receiver);
            emit IntentExecuted(
                config.intentId,
                config.receiver,
                config.tokenOut,
                address(this).balance
            );
            return;
        } else {
            uint256 balance = IERC20(config.tokenOut).balanceOf(address(this));
            // Handle ERC20 output
            if (balance < config.amountOutMin) {
                revert InsufficientOutputAmount();
            }
            SafeTransferLib.safeTransferAll(config.tokenOut, config.receiver);
            emit IntentExecuted(
                config.intentId,
                config.receiver,
                config.tokenOut,
                balance
            );
        }
    }

    /// @notice Withdraws all the tokens.
    /// @param tokens The tokens to withdraw.
    function withdrawAll(address[] calldata tokens) external {
        if (msg.sender != config.factory) {
            revert Unauthorized();
        }
        for (uint256 i = 0; i < tokens.length; ) {
            if (tokens[i] == address(0)) {
                SafeTransferLib.safeTransferAllETH(config.receiver);
                unchecked {
                    ++i;
                }
                continue;
            }
            SafeTransferLib.safeTransferAll(tokens[i], config.receiver);
            unchecked {
                ++i;
            }
        }
    }

    // Recieve ETH
    receive() external payable {}
}
