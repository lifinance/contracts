// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import { LibPackedStream } from "lifi/Libraries/LibPackedStream.sol";
import { LibUtil } from "lifi/Libraries/LibUtil.sol";
import { LibDiamondLoupe } from "lifi/Libraries/LibDiamondLoupe.sol";
import { LibAsset } from "lifi/Libraries/LibAsset.sol";
import { ReentrancyGuard } from "lifi/Helpers/ReentrancyGuard.sol";
import { WithdrawablePeriphery } from "lifi/Helpers/WithdrawablePeriphery.sol";
import { InvalidConfig } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "./BaseRouteConstants.sol";

/// @title CoreRouteFacet
/// @author LI.FI (https://li.fi)
/// @notice Orchestrates LDA route execution using direct function selector dispatch
/// @dev Implements selector-based routing where each DEX facet's swap function is called directly via its selector
/// @custom:version 1.0.0
contract CoreRouteFacet is
    BaseRouteConstants,
    ReentrancyGuard,
    WithdrawablePeriphery
{
    using SafeERC20 for IERC20;
    using SafeERC20 for IERC20Permit;
    using LibPackedStream for uint256;

    // ==== Events ====
    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    // ==== Errors ====
    error MinimalOutputBalanceViolation(uint256 amountOut);
    error MinimalInputBalanceViolation(uint256 available, uint256 required);
    error UnknownCommandCode();
    error SwapFailed();
    error UnknownSelector();

    constructor(address _owner) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) revert InvalidConfig();
    }

    // ==== External Functions ====
    /// @notice Process a route encoded with function selectors for direct DEX facet dispatch
    /// @param tokenIn The input token address (address(0) for native)
    /// @param amountIn The amount of input tokens
    /// @param tokenOut The expected output token address (address(0) for native)
    /// @param amountOutMin The minimum acceptable output amount
    /// @param to The recipient address for the output tokens
    /// @param route The encoded route data containing function selectors and parameters
    /// @return amountOut The actual amount of output tokens received
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

    // ==== Private Functions - Core Logic ====
    /// @notice Executes a route with balance checks and event emission
    /// @dev Handles both native and ERC20 tokens with pre/post balance validation
    /// @param tokenIn The input token address (address(0) for native)
    /// @param amountIn The amount of input tokens
    /// @param tokenOut The expected output token address (address(0) for native)
    /// @param amountOutMin The minimum acceptable output amount
    /// @param to The recipient address for the output tokens
    /// @param route The encoded route data containing function selectors and parameters
    /// @return amountOut The actual amount of output tokens received
    function _executeRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes calldata route
    ) private returns (uint256 amountOut) {
        uint256 balInInitial = LibAsset.isNativeAsset(tokenIn)
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);

        uint256 balOutInitial = LibAsset.isNativeAsset(tokenOut)
            ? address(to).balance
            : IERC20(tokenOut).balanceOf(to);

        uint256 realAmountIn = _runRoute(tokenIn, amountIn, route);

        uint256 balInFinal = LibAsset.isNativeAsset(tokenIn)
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);
        if (balInFinal + amountIn < balInInitial) {
            revert MinimalInputBalanceViolation(
                balInFinal + amountIn,
                balInInitial
            );
        }

        uint256 balOutFinal = LibAsset.isNativeAsset(tokenOut)
            ? address(to).balance
            : IERC20(tokenOut).balanceOf(to);
        if (balOutFinal < balOutInitial + amountOutMin) {
            revert MinimalOutputBalanceViolation(balOutFinal - balOutInitial);
        }

        amountOut = balOutFinal - balOutInitial;

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

    /// @notice Interprets and executes commands from the route byte stream
    /// @dev Processes commands in sequence: ERC20, native, permits, and pool interactions
    /// @param tokenIn The input token address
    /// @param declaredAmountIn The declared input amount
    /// @param route The encoded route data
    /// @return realAmountIn The actual amount used in the first hop
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

    // ==== Private Functions - Command Handlers ====

    /// @notice Applies ERC20 permit for token approval
    /// @dev Reads permit parameters from the stream and calls permit on the token
    /// @param tokenIn The token to approve
    /// @param cur The current position in the byte stream
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

    /// @notice Handles native token (ETH) inputs
    /// @dev Assumes ETH is already present on the contract
    /// @param cur The current position in the byte stream
    /// @return total The total amount of ETH to process
    function _handleNative(uint256 cur) private returns (uint256 total) {
        total = address(this).balance;
        _distributeAndSwap(cur, address(this), INTERNAL_INPUT_SOURCE, total);
    }

    /// @notice Processes ERC20 tokens already on this contract
    /// @dev Includes protection against full balance draining
    /// @param cur The current position in the byte stream
    /// @return total The total amount of tokens to process
    function _handleSelfERC20(uint256 cur) private returns (uint256 total) {
        address token = cur.readAddress();
        total = IERC20(token).balanceOf(address(this));
        unchecked {
            if (total > 0) total -= 1; // slot undrain protection
        }
        _distributeAndSwap(cur, address(this), token, total);
    }

    /// @notice Processes ERC20 tokens from the caller
    /// @param cur The current position in the byte stream
    /// @param total The total amount to process
    function _handleUserERC20(uint256 cur, uint256 total) private {
        address token = cur.readAddress();
        _distributeAndSwap(cur, msg.sender, token, total);
    }

    /// @notice Processes a pool interaction where tokens are already in the pool
    /// @param cur The current position in the byte stream
    function _handleSinglePool(uint256 cur) private {
        address token = cur.readAddress();
        _dispatchSwap(cur, INTERNAL_INPUT_SOURCE, token, 0);
    }

    /// @notice Distributes tokens across multiple pools based on share ratios
    /// @param cur The current position in the byte stream
    /// @param from The source address for tokens
    /// @param tokenIn The token being distributed
    /// @param total The total amount to distribute
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

    /// @notice Dispatches a swap call to the appropriate DEX facet
    /// @dev Uses direct selector dispatch with optimized calldata construction
    /// @param cur The current position in the byte stream
    /// @param from The source address for tokens
    /// @param tokenIn The input token address
    /// @param amountIn The amount of tokens to swap
    function _dispatchSwap(
        uint256 cur,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        bytes memory data = cur.readBytesWithLength();

        bytes4 selector = _readSelector(data);
        // in-place payload alias (no copy)
        bytes memory payload;
        assembly {
            payload := add(data, 4)
            mstore(payload, sub(mload(data), 4))
        }

        address facet = LibDiamondLoupe.facetAddress(selector);
        if (facet == address(0)) revert UnknownSelector();

        bool success;
        bytes memory returnData;
        assembly {
            let free := mload(0x40)
            // selector
            mstore(free, selector)
            let args := add(free, 4)

            // head (4 args): [offset_to_payload, from, tokenIn, amountIn]
            mstore(args, 0x80) // offset to payload data (after 4 static slots)
            mstore(add(args, 0x20), from)
            mstore(add(args, 0x40), tokenIn)
            mstore(add(args, 0x60), amountIn)

            // payload area
            let d := add(args, 0x80)
            let len := mload(payload)
            mstore(d, len)
            // copy payload bytes
            // identity precompile is cheapest for arbitrary-length copy
            pop(
                staticcall(gas(), 0x04, add(payload, 32), len, add(d, 32), len)
            )

            let padded := and(add(len, 31), not(31))
            let total := add(4, add(0x80, add(0x20, padded)))
            success := delegatecall(gas(), facet, free, total, 0, 0)

            // update free memory pointer
            mstore(0x40, add(free, total))

            // capture return data
            let rsize := returndatasize()
            returnData := mload(0x40)
            mstore(returnData, rsize)
            let rptr := add(returnData, 32)
            returndatacopy(rptr, 0, rsize)
            mstore(0x40, add(rptr, and(add(rsize, 31), not(31))))
        }

        if (!success) {
            LibUtil.revertWith(returnData);
        }
    }

    // ==== Private Functions - Helpers ====

    /// @notice Extracts function selector from calldata
    /// @param blob The calldata bytes
    /// @return sel The extracted selector
    function _readSelector(
        bytes memory blob
    ) private pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(blob, 32))
        }
    }

    /// @notice Creates a new bytes array without the selector
    /// @param blob The original calldata bytes
    /// @return payload The calldata without selector
    function _payloadFrom(
        bytes memory blob
    ) private pure returns (bytes memory payload) {
        assembly {
            payload := add(blob, 4)
            mstore(payload, sub(mload(blob), 4))
        }
    }
}
