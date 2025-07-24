// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { LibInputStream } from "lifi/Libraries/LibInputStream.sol";
import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { ReentrancyGuard } from "lifi/Helpers/ReentrancyGuard.sol";
import { LibDiamondLoupe } from "lifi/Libraries/LibDiamondLoupe.sol";

/// @title Core Route Facet
/// @author LI.FI (https://li.fi)
/// @notice Handles route processing and selector-based swap dispatching for LDA 2.0
/// @custom:version 2.0.0
contract CoreRouteFacet is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IERC20Permit;
    using LibInputStream for uint256;

    /// Constants ///
    address internal constant NATIVE_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address internal constant INTERNAL_INPUT_SOURCE = address(0);

    /// Events ///
    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    /// Errors ///
    error MinimalOutputBalanceViolation(uint256 amountOut);
    error MinimalInputBalanceViolation(uint256 available, uint256 required);
    error UnknownCommandCode();
    error SwapFailed();
    error UnknownSelector();

    /// External Methods ///

    /// @notice Processes a route for swapping tokens using selector-based dispatch
    /// @param tokenIn Token to swap from
    /// @param amountIn Amount of tokenIn to swap
    /// @param tokenOut Token to swap to
    /// @param amountOutMin Minimum amount of tokenOut expected
    /// @param to Recipient of the final tokens
    /// @param route Encoded route data containing swap instructions
    function processRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes calldata route
    ) external payable nonReentrant returns (uint256 amountOut) {
        return
            _processRouteInternal(
                tokenIn,
                amountIn,
                tokenOut,
                amountOutMin,
                to,
                route
            );
    }

    /// Internal Methods ///

    /// @notice Internal route processing logic
    function _processRouteInternal(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes calldata route
    ) private returns (uint256 amountOut) {
        uint256 balanceInInitial = tokenIn == NATIVE_ADDRESS
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);
        uint256 balanceOutInitial = tokenOut == NATIVE_ADDRESS
            ? address(to).balance
            : IERC20(tokenOut).balanceOf(to);

        uint256 realAmountIn = amountIn;
        {
            uint256 step = 0;
            uint256 stream = LibInputStream.createStream(route);
            while (stream.isNotEmpty()) {
                uint8 commandCode = stream.readUint8();
                if (commandCode == 1) {
                    uint256 usedAmount = _processMyERC20(stream);
                    if (step == 0) realAmountIn = usedAmount;
                } else if (commandCode == 2) {
                    _processUserERC20(stream, amountIn);
                } else if (commandCode == 3) {
                    uint256 usedAmount = _processNative(stream);
                    if (step == 0) realAmountIn = usedAmount;
                } else if (commandCode == 4) {
                    _processOnePool(stream);
                } else if (commandCode == 6) {
                    _applyPermit(tokenIn, stream);
                } else {
                    revert UnknownCommandCode();
                }
                ++step;
            }
        }

        uint256 balanceInFinal = tokenIn == NATIVE_ADDRESS
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);
        if (balanceInFinal + amountIn < balanceInInitial) {
            revert MinimalInputBalanceViolation(
                balanceInFinal + amountIn,
                balanceInInitial
            );
        }

        uint256 balanceOutFinal = tokenOut == NATIVE_ADDRESS
            ? address(to).balance
            : IERC20(tokenOut).balanceOf(to);
        if (balanceOutFinal < balanceOutInitial + amountOutMin) {
            revert MinimalOutputBalanceViolation(
                balanceOutFinal - balanceOutInitial
            );
        }

        amountOut = balanceOutFinal - balanceOutInitial;

        emit Route(
            msg.sender,
            to,
            tokenIn,
            tokenOut,
            realAmountIn,
            amountOutMin,
            amountOut
        );
    }

    /// @notice Applies ERC-2612 permit
    function _applyPermit(address tokenIn, uint256 stream) private {
        uint256 value = stream.readUint();
        uint256 deadline = stream.readUint();
        uint8 v = stream.readUint8();
        bytes32 r = stream.readBytes32();
        bytes32 s = stream.readBytes32();
        IERC20Permit(tokenIn).safePermit(
            msg.sender,
            address(this),
            value,
            deadline,
            v,
            r,
            s
        );
    }

    /// @notice Processes native coin
    function _processNative(
        uint256 stream
    ) private returns (uint256 amountTotal) {
        amountTotal = address(this).balance;
        _distributeAndSwap(stream, address(this), NATIVE_ADDRESS, amountTotal);
    }

    /// @notice Processes ERC20 token from this contract balance
    function _processMyERC20(
        uint256 stream
    ) private returns (uint256 amountTotal) {
        address token = stream.readAddress();
        amountTotal = IERC20(token).balanceOf(address(this));
        unchecked {
            if (amountTotal > 0) amountTotal -= 1; // slot undrain protection
        }
        _distributeAndSwap(stream, address(this), token, amountTotal);
    }

    /// @notice Processes ERC20 token from msg.sender balance
    function _processUserERC20(uint256 stream, uint256 amountTotal) private {
        address token = stream.readAddress();
        _distributeAndSwap(stream, msg.sender, token, amountTotal);
    }

    /// @notice Processes single pool (tokens already at pool)
    function _processOnePool(uint256 stream) private {
        address token = stream.readAddress();
        _dispatchSwap(stream, INTERNAL_INPUT_SOURCE, token, 0);
    }

    /// @notice Distributes amount to pools and calls swap for each
    function _distributeAndSwap(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountTotal
    ) private {
        uint8 num = stream.readUint8();
        unchecked {
            for (uint256 i = 0; i < num; ++i) {
                uint16 share = stream.readUint16();
                uint256 amount = (amountTotal * share) / type(uint16).max;
                amountTotal -= amount;
                _dispatchSwap(stream, from, tokenIn, amount);
            }
        }
    }

    /// @notice Dispatches swap using selector-based approach
    /// @dev This is the core of the selector-based dispatch system
    function _dispatchSwap(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        // Read the function selector from the stream
        bytes4 selector = stream.readBytes4();

        // Look up facet address using LibDiamondLoupe
        address facet = LibDiamondLoupe.facetAddress(selector);
        if (facet == address(0)) revert UnknownSelector();

        // Prepare calldata: selector + remaining stream + additional parameters
        bytes memory data = abi.encodePacked(
            selector,
            stream,
            from,
            tokenIn,
            amountIn
        );

        // Execute the swap via delegatecall to the facet
        (bool success, ) = facet.delegatecall(data);
        if (!success) {
            revert SwapFailed();
        }

        // Note: Individual facets can return amounts if needed, but for now we rely on balance checks
    }
}
