// SPDX-License-Identifier: Unlicense
pragma solidity 0.8.17;

import { InsufficientBalance } from "lifi/Errors/GenericErrors.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

// this contract is used for testing purposes and mocks the behaviour of a Uniswap-like DEX
// it has two main functionalities:
// 1) pull a specified amount of the input token (for testing of cases where not all inputTokens are used by a DEX)
// 2) return any token/amount combination to the receiver address as specificied prior to the call
contract MockUniswapDEX {
    using SafeTransferLib for ERC20;

    ERC20 public outputToken;
    uint256 public inputAmount;
    uint256 public outputAmount;

    // sets the output token and output amount for function "swapWithPresetOutcome"
    function setSwapOutput(
        uint256 _inputAmount,
        ERC20 _outputToken,
        uint256 _outputAmount
    ) external {
        // make sure that the contract is sufficiently funded
        uint256 balance = _outputToken.balanceOf(address(this));
        if (balance < _outputAmount)
            revert InsufficientBalance(_outputAmount, balance);

        // store token and amounts
        inputAmount = _inputAmount;
        outputToken = _outputToken;
        outputAmount = _outputAmount;
    }

    // this function will:
    // - pull the specified amount of inputTokens (>> mock positive slippage), if variable 'inputAmount' is set (otherwise it will pull _maxInputAmount)
    // - return the preset 'outputAmount' of 'outputToken' to the receiver (to)
    function swapTokensForExactTokens(
        uint256,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256
    ) external {
        // pull input token
        address inputToken = path[0];
        if (inputToken == address(0)) {
            // native
        } else {
            // ERC20
            ERC20 token = ERC20(path[0]);
            token.safeTransferFrom(
                msg.sender,
                address(this),
                inputAmount == 0 ? amountInMax : inputAmount
            );
        }

        // make sure that the contract is sufficiently funded
        uint256 balance = outputToken.balanceOf(address(this));
        if (balance < outputAmount)
            revert InsufficientBalance(outputAmount, balance);

        // return preset output token and amount
        outputToken.safeTransfer(to, outputAmount);
    }

    // this function will:
    // - return the preset 'outputAmount' of 'outputToken' to the receiver (to)
    function swapExactTokensForTokens(
        uint256,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256
    ) external {
        // pull input token
        ERC20 token = ERC20(path[0]);
        token.safeTransferFrom(
            msg.sender,
            address(this),
            inputAmount == 0 ? amountInMax : inputAmount
        );

        // make sure that the contract is sufficiently funded
        uint256 balance = outputToken.balanceOf(address(this));
        if (balance < outputAmount)
            revert InsufficientBalance(outputAmount, balance);

        // return preset output token and amount
        outputToken.safeTransfer(to, outputAmount);
    }
}
