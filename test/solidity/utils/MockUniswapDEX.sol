// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import { InsufficientBalance, NativeAssetTransferFailed } from "lifi/Errors/GenericErrors.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";
import { console2 } from "forge-std/console2.sol";

// this contract is used for testing purposes and mocks the behaviour of a Uniswap-like DEX but
// adds the option to simulate positive slippage as well as failing swaps
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
    ) external payable {
        // make sure that the contract is sufficiently funded
        uint256 balance = address(_outputToken) == address(0)
            ? address(this).balance
            : _outputToken.balanceOf(address(this));
        if (balance < _outputAmount)
            revert InsufficientBalance(_outputAmount, balance);

        // store token and amounts
        inputAmount = _inputAmount;
        outputToken = _outputToken;
        outputAmount = _outputAmount;
    }

    // this function is capable to mock various slippage issues on a DEX swap:
    // - pulling less sendingAsset tokens than expected (or refunding a part in case of native) the specified amount of inputTokens (>> mock positive slippage)
    //   if 'inputAmount' state variable is set: use this value, otherwise use value of 'amountInIfNotPreset' parameter
    // - returning less receivingAsset tokens than expected
    //   if 'outputAmount' state variable is set: use this value, otherwise use value of 'amountOutIfNotPreset' parameter
    // it is possible to combine both functionalities
    function mockSwapWithPresetInputAndOutput(
        uint256 amountInIfNotPreset,
        uint256 amountOutIfNotPreset,
        address[] memory path,
        address to
    ) public payable {
        bool isNativeInput = path[0] == address(0);

        // pull input token
        uint256 amountToPull = inputAmount == 0
            ? amountInIfNotPreset
            : inputAmount;
        if (isNativeInput) {
            // Pull NATIVE
            if (
                inputAmount > 0 && inputAmount != msg.value
            ) // for native we will just refund some of the msg.value in case inputAmount is set
            {
                // calculate diff
                uint256 unusedNativeAsset = msg.value - inputAmount;

                // send unused tokens back to msg.sender           // solhint-disable-next-line avoid-low-level-calls
                (bool success, ) = msg.sender.call{ value: unusedNativeAsset }(
                    ""
                );
                if (!success) revert NativeAssetTransferFailed();
            }
        }
        // Pull ERC20
        else
            ERC20(path[0]).safeTransferFrom(
                msg.sender,
                address(this),
                amountToPull
            );

        // make sure that the contract is sufficiently funded
        bool isNativeOutput = address(outputToken) == address(0);

        uint256 amountToReturn = outputAmount == 0
            ? amountOutIfNotPreset
            : outputAmount;
        uint256 balance = isNativeOutput
            ? address(this).balance
            : ERC20(path[1]).balanceOf(address(this));
        if (balance < outputAmount)
            revert InsufficientBalance(outputAmount, balance);

        // return preset output token and amount
        if (isNativeOutput) {
            // NATIVE
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = to.call{ value: amountToReturn }("");
            if (!success) revert NativeAssetTransferFailed();
        } else {
            //ERC20
            ERC20(outputToken).safeTransfer(to, amountToReturn);
        }
    }

    // d'oh :)
    function mockSwapWillRevertWithReason(
        string calldata reason
    ) external payable {
        revert(reason);
    }

    // UNISWAP-LIKE FUNCTION SELECTORS FOR BETTER COMPATIBILITY WITH EXISTING CODE

    // ERC20 to ERC20
    function swapTokensForExactTokens(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256
    ) external payable {
        mockSwapWithPresetInputAndOutput(amountOut, amountInMax, path, to);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        mockSwapWithPresetInputAndOutput(amountIn, amountOutMin, path, to);
    }

    // NATIVE TO ERC20

    function swapETHForExactTokens(
        uint256 amountOut,
        address[] calldata path,
        address to,
        uint256
    ) external payable {
        // same functionality (for this context)
        swapExactETHForTokens(amountOut, path, to, 0);
    }

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) public payable {
        // since the path contains the WETH address, we need to replace it with address(0)
        address[] memory adjustedPath = new address[](2);
        adjustedPath[0] = address(0);
        adjustedPath[1] = path[1];

        // execute the swap
        mockSwapWithPresetInputAndOutput(0, amountOutMin, adjustedPath, to);
    }

    // ERC20 TO NATIVE

    function swapExactTokensForETH(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external {
        // same functionality (for this context)
        swapTokensForExactETH(amountOutMin, amountIn, path, to, 0);
    }

    function swapTokensForExactETH(
        uint256 amountOut,
        uint256 amountInMax,
        address[] calldata path,
        address to,
        uint256
    ) public {
        // since the path contains the WETH address, we need to replace it with address(0)
        address[] memory adjustedPath = new address[](2);
        adjustedPath[0] = path[0];
        adjustedPath[1] = address(0);

        // execute the swap
        mockSwapWithPresetInputAndOutput(
            amountInMax,
            amountOut,
            adjustedPath,
            to
        );
    }
}
