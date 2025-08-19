// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { ReentrancyGuard } from "lifi/Helpers/ReentrancyGuard.sol";
import { LibDiamondLoupe } from "lifi/Libraries/LibDiamondLoupe.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";

/// @title CoreRouteFacet
/// @author LI.FI (https://li.fi)
/// @notice Orchestrates LDA route execution by interpreting a compact byte stream.
/// @dev Public surface (ABI) is preserved; internals are reorganized for clarity.
/// @custom:version 1.0.0
contract CoreRouteFacet is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeERC20 for IERC20Permit;
    using LibPackedStream for uint256;

    /// @dev sentinel used to indicate that the input is already at the destination pool
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

    function processRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes calldata route
    ) external payable nonReentrant returns (uint256 amountOut) {
        return
            _executeRoute(
                tokenIn,
                amountIn,
                tokenOut,
                amountOutMin,
                to,
                route
            );
    }

    function _executeRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes calldata route
    ) private returns (uint256 amountOut) {
        (uint256 balInStart, uint256 balOutStart) = _precheck(
            tokenIn,
            tokenOut,
            to
        );

        uint256 realAmountIn = _runRoute(tokenIn, amountIn, route);

        amountOut = _postcheck(
            tokenIn,
            tokenOut,
            to,
            amountIn,
            amountOutMin,
            balInStart,
            balOutStart
        );

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

    /// @notice Capture initial balances for input/output accounting.
    function _precheck(
        address tokenIn,
        address tokenOut,
        address to
    ) private view returns (uint256 balInStart, uint256 balOutStart) {
        balInStart = LibAsset.isNativeAsset(tokenIn)
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);

        balOutStart = LibAsset.isNativeAsset(tokenOut)
            ? address(to).balance
            : IERC20(tokenOut).balanceOf(to);
    }

    /// @notice Interpret the `route` byte stream and perform all commanded actions.
    /// @return realAmountIn The actual first-hop amount determined by the route.
    function _runRoute(
        address tokenIn,
        uint256 declaredAmountIn,
        bytes calldata route
    ) private returns (uint256 realAmountIn) {
        realAmountIn = declaredAmountIn;
        uint256 step = 0;

        uint256 cur = LibPackedStream.createStream(route);
        while (cur.isNotEmpty()) {
            uint8 opcode = cur.readUint8();
            if (opcode == 1) {
                uint256 used = _handleSelfERC20(cur);
                if (step == 0) realAmountIn = used;
            } else if (opcode == 2) {
                _handleUserERC20(cur, declaredAmountIn);
            } else if (opcode == 3) {
                uint256 usedNative = _handleNative(cur);
                if (step == 0) realAmountIn = usedNative;
            } else if (opcode == 4) {
                _handleSinglePool(cur);
            } else if (opcode == 5) {
                _applyPermit(tokenIn, cur);
            } else {
                revert UnknownCommandCode();
            }
            unchecked {
                ++step;
            }
        }
    }

    /// @notice Validate post-conditions and determine `amountOut`.
    function _postcheck(
        address tokenIn,
        address tokenOut,
        address to,
        uint256 declaredAmountIn,
        uint256 minAmountOut,
        uint256 balInStart,
        uint256 balOutStart
    ) private view returns (uint256 amountOut) {
        uint256 balInFinal = LibAsset.isNativeAsset(tokenIn)
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);
        if (balInFinal + declaredAmountIn < balInStart) {
            revert MinimalInputBalanceViolation(
                balInFinal + declaredAmountIn,
                balInStart
            );
        }

        uint256 balOutFinal = LibAsset.isNativeAsset(tokenOut)
            ? address(to).balance
            : IERC20(tokenOut).balanceOf(to);
        if (balOutFinal < balOutStart + minAmountOut) {
            revert MinimalOutputBalanceViolation(balOutFinal - balOutStart);
        }

        amountOut = balOutFinal - balOutStart;
    }

    /// ===== Command handlers (renamed/reorganized) =====

    /// @notice ERC-2612 permit application for `tokenIn`.
    function _applyPermit(address tokenIn, uint256 cur) private {
        uint256 value = cur.readUint256();
        uint256 deadline = cur.readUint256();
        uint8 v = cur.readUint8();
        bytes32 r = cur.readBytes32();
        bytes32 s = cur.readBytes32();
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

    /// @notice Handle native coin inputs (assumes value already present on this contract).
    function _handleNative(uint256 cur) private returns (uint256 total) {
        total = address(this).balance;
        _distributeAndSwap(cur, address(this), INTERNAL_INPUT_SOURCE, total);
    }

    /// @notice Pull ERC20 from this contract’s balance and process it.
    function _handleSelfERC20(uint256 cur) private returns (uint256 total) {
        address token = cur.readAddress();
        total = IERC20(token).balanceOf(address(this));
        unchecked {
            if (total > 0) total -= 1; // slot undrain protection
        }
        _distributeAndSwap(cur, address(this), token, total);
    }

    /// @notice Pull ERC20 from the caller and process it.
    function _handleUserERC20(uint256 cur, uint256 total) private {
        address token = cur.readAddress();
        _distributeAndSwap(cur, msg.sender, token, total);
    }

    /// @notice Process a “single pool” hop where inputs are already resident in the pool.
    function _handleSinglePool(uint256 cur) private {
        address token = cur.readAddress();
        _dispatchSwap(cur, INTERNAL_INPUT_SOURCE, token, 0);
    }

    /// @notice Split an amount across N pools and trigger swaps.
    function _distributeAndSwap(
        uint256 cur,
        address from,
        address tokenIn,
        uint256 total
    ) private {
        uint8 n = cur.readUint8();
        unchecked {
            for (uint256 i = 0; i < n; ++i) {
                uint16 share = cur.readUint16();
                uint256 amt = (total * share) / type(uint16).max;
                total -= amt;
                _dispatchSwap(cur, from, tokenIn, amt);
            }
        }
    }

    /// @notice Extract selector and payload and delegate the call to the facet that implements it.
    function _dispatchSwap(
        uint256 cur,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        bytes memory data = cur.readBytesWithLength();

        bytes4 selector = _readSelector(data);
        bytes memory payload = _payloadFrom(data);

        address facet = LibDiamondLoupe.facetAddress(selector);
        if (facet == address(0)) revert UnknownSelector();

        (bool ok, bytes memory ret) = facet.delegatecall(
            abi.encodeWithSelector(selector, payload, from, tokenIn, amountIn)
        );
        if (!ok) {
            LibUtil.revertWith(ret);
        }
    }

    /// ===== Helpers =====

    /// @dev Extracts the first 4 bytes as a selector.
    function _readSelector(
        bytes memory blob
    ) private pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(blob, 32))
        }
    }

    /// @dev Returns a fresh bytes containing the original blob without the first 4 bytes.
    function _payloadFrom(
        bytes memory blob
    ) private view returns (bytes memory out) {
        uint256 len = blob.length;
        if (len <= 4) return new bytes(0);

        uint256 newLen = len - 4;
        assembly {
            out := mload(0x40)
            mstore(0x40, add(out, add(newLen, 32)))
            mstore(out, newLen)
            let src := add(blob, 36) // skip length(32) + 4
            pop(staticcall(gas(), 4, src, newLen, add(out, 32), newLen))
        }
    }
}
