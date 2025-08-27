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
import { InvalidConfig, InvalidReceiver } from "lifi/Errors/GenericErrors.sol";
import { BaseRouteConstants } from "../BaseRouteConstants.sol";

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
        address receiverAddress,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    // ==== Errors ====
    error SwapTokenInSpendingExceeded(
        uint256 actualSpent,
        uint256 expectedSpent
    );
    error SwapTokenOutAmountTooLow(uint256 actualOutput);
    error UnknownCommandCode();
    error SwapFailed();
    error UnknownSelector();

    /// @notice Constructor
    /// @param _owner The address of the contract owner
    constructor(address _owner) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) revert InvalidConfig();
    }

    // ==== External Functions ====
    /// @notice Process a route encoded with function selectors for direct DEX facet dispatch
    /// @param tokenIn The input token address (address(0) for native)
    /// @param amountIn The amount of input tokens
    /// @param tokenOut The expected output token address (address(0) for native)
    /// @param amountOutMin The minimum acceptable output amount
    /// @param receiverAddress The receiver address for the output tokens
    /// @param route The encoded route data containing function selectors and parameters
    /// @return amountOut The actual amount of output tokens received
    function processRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address receiverAddress,
        bytes calldata route
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (receiverAddress == address(0)) revert InvalidReceiver();
        return
            _executeRoute(
                tokenIn,
                amountIn,
                tokenOut,
                amountOutMin,
                receiverAddress,
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
    /// @param receiverAddress The receiver address for the output tokens
    /// @param route The encoded route data containing function selectors and parameters
    /// @return amountOut The actual amount of output tokens received
    function _executeRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address receiverAddress,
        bytes calldata route
    ) private returns (uint256 amountOut) {
        bool isNativeIn = LibAsset.isNativeAsset(tokenIn);
        bool isNativeOut = LibAsset.isNativeAsset(tokenOut);

        // Get initial token balances, with special handling for native assets
        (uint256 balInInitial, uint256 balOutInitial) = _getInitialBalances(
            tokenIn,
            tokenOut,
            receiverAddress,
            isNativeIn,
            isNativeOut
        );

        // Execute the route and get actual input amount used (may differ from amountIn for some opcodes)
        uint256 realAmountIn = _runRoute(tokenIn, amountIn, route);

        // Verify balances after route execution and calculate output amount
        amountOut = _getFinalBalancesAndCheck(
            tokenIn,
            amountIn,
            balInInitial,
            tokenOut,
            amountOutMin,
            balOutInitial,
            receiverAddress,
            isNativeIn,
            isNativeOut
        );

        emit Route(
            msg.sender,
            receiverAddress,
            tokenIn,
            tokenOut,
            realAmountIn,
            amountOutMin,
            amountOut
        );
    }

    /// @notice Gets initial balances for both input and output tokens before route execution
    /// @dev For native input assets (ETH), we return 0 since:
    ///      1. ETH balance checks would be misleading due to gas costs
    ///      2. Native asset handling is done via _handleNative which consumes all ETH on the contract
    /// @param tokenIn The input token address
    /// @param tokenOut The output token address
    /// @param receiverAddress The receiver address for output tokens
    /// @param isNativeIn Whether input token is native ETH
    /// @param isNativeOut Whether output token is native ETH
    /// @return balInInitial Initial balance of input token
    /// @return balOutInitial Initial balance of output token
    function _getInitialBalances(
        address tokenIn,
        address tokenOut,
        address receiverAddress,
        bool isNativeIn,
        bool isNativeOut
    ) private view returns (uint256 balInInitial, uint256 balOutInitial) {
        balInInitial = isNativeIn ? 0 : IERC20(tokenIn).balanceOf(msg.sender);
        balOutInitial = isNativeOut
            ? address(receiverAddress).balance
            : IERC20(tokenOut).balanceOf(receiverAddress);
    }

    function _getFinalBalancesAndCheck(
        address tokenIn,
        uint256 amountIn,
        uint256 balInInitial,
        address tokenOut,
        uint256 amountOutMin,
        uint256 balOutInitial,
        address receiverAddress,
        bool isNativeIn,
        bool isNativeOut
    ) private view returns (uint256 amountOut) {
        uint256 balInFinal = isNativeIn
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);
        if (balInFinal + amountIn < balInInitial) {
            revert SwapTokenInSpendingExceeded(
                balInFinal + amountIn,
                balInInitial
            );
        }

        uint256 balOutFinal = isNativeOut
            ? address(receiverAddress).balance
            : IERC20(tokenOut).balanceOf(receiverAddress);
        amountOut = balOutFinal - balOutInitial;
        if (amountOut < amountOutMin) {
            revert SwapTokenOutAmountTooLow(amountOut);
        }
    }

    /// @notice Interprets and executes commands from the route byte stream
    /// @dev A route is a packed byte stream of sequential commands. Each command begins with a 1-byte route command:
    /// - 1 = DistributeSelfERC20 (distributes and swaps tokens already on this contract)
    /// - 2 = DistributeUserERC20 (distributes and swaps tokens from user)
    /// - 3 = DistributeNative (distributes and swaps ETH held by this contract)
    /// - 4 = DispatchSinglePoolSwap (dispatches swap using tokens already in pool)
    /// - 5 = ApplyPermit (EIP-2612 permit for tokenIn on behalf of msg.sender)
    ///
    /// Stream formats per route command:
    /// 1. DistributeSelfERC20:
    ///    [1][token: address][n: uint8] then n legs, each:
    ///      [share: uint16][len: uint16][data: bytes]
    ///    total = IERC20(token).balanceOf(address(this)) minus 1 wei (prevents tiny swaps)
    ///    from = address(this), tokenIn = token
    ///
    /// 2. DistributeUserERC20:
    ///    [2][token: address][n: uint8] then n legs, each:
    ///      [share: uint16][len: uint16][data: bytes]
    ///    total = declaredAmountIn
    ///    from = msg.sender, tokenIn = token
    ///
    /// 3. DistributeNative:
    ///    [3][n: uint8] then n legs, each:
    ///      [share: uint16][len: uint16][data: bytes]
    ///    total = address(this).balance (includes msg.value and any residual ETH)
    ///    from = address(this), tokenIn = INTERNAL_INPUT_SOURCE
    ///
    /// 4. DispatchSinglePoolSwap:
    ///    [4][token: address][len: uint16][data: bytes]
    ///    amountIn = 0 (pool sources tokens internally), from = INTERNAL_INPUT_SOURCE
    ///
    /// 5. ApplyPermit:
    ///    [5][value: uint256][deadline: uint256][v: uint8][r: bytes32][s: bytes32]
    ///    Calls permit on tokenIn for msg.sender → address(this). No swap occurs.
    ///
    /// Leg data encoding:
    /// Each leg's data field contains [selector (4 bytes) | payload (bytes)].
    /// The selector determines the DEX facet function to call. The router delegatecalls the facet with:
    /// (bytes swapData, address from, address tokenIn, uint256 amountIn)
    /// where swapData is the payload from the route, containing DEX-specific data:
    /// - Example for UniV3-style: abi.encode(pool, direction, destinationAddress) // for Uniswap V3, PancakeV3, etc.
    /// - Each DEX facet defines its own payload format based on what its pools need
    ///
    /// Example multihop route (two legs on user ERC20, then single-pool hop):
    /// ```
    /// // Leg payloads with facet selectors:
    /// leg1 = abi.encodePacked(
    ///     UniV3StyleFacet.swapUniV3.selector,
    ///     abi.encode(poolA, DIRECTION_TOKEN0_TO_TOKEN1, poolC)  // destinationAddress is the final pool
    /// );
    /// leg2 = abi.encodePacked(
    ///     IzumiV3Facet.swapIzumiV3.selector,
    ///     abi.encode(poolB, DIRECTION_TOKEN0_TO_TOKEN1, poolC)  // destinationAddress is the final pool
    /// );
    /// leg3 = abi.encodePacked(
    ///     SomePoolFacet.swapSinglePool.selector,
    ///     abi.encode(poolC, finalReceiver, otherPoolParams)  // pool that received tokens from leg1&2
    /// );
    ///
    /// // Full route: [2][tokenA][2 legs][60% leg1][40% leg2] then [4][tokenB][leg3]
    /// route = abi.encodePacked(
    ///     uint8(2), tokenA, uint8(2),                          // DistributeUserERC20 with 2 legs
    ///     uint16(39321), uint16(leg1.length), leg1,   // ~60% of amountIn
    ///     uint16(26214), uint16(leg2.length), leg2,   // ~40% of amountIn
    ///     uint8(4), tokenB,                                    // DispatchSinglePoolSwap
    ///     uint16(leg3.length), leg3
    /// );
    /// ```
    /// @param tokenIn The input token address
    /// @param declaredAmountIn The declared input amount
    /// @param route The encoded route data
    /// @return realAmountIn The actual amount used in the first hop. For opcode 1: contract balance minus 1,
    ///         for opcode 3: contract's ETH balance, for opcode 2: equals declaredAmountIn
    function _runRoute(
        address tokenIn,
        uint256 declaredAmountIn,
        bytes calldata route
    ) private returns (uint256 realAmountIn) {
        realAmountIn = declaredAmountIn;
        uint256 step = 0;

        uint256 cur = LibPackedStream.createStream(route);
        // Iterate until the packed route stream is fully consumed.
        // `isNotEmpty()` returns true while there are unread bytes left in the stream.
        while (cur.isNotEmpty()) {
            // Read the next command byte that specifies how to handle tokens in this step
            uint8 routeCommand = cur.readUint8();
            if (routeCommand == 1) {
                uint256 used = _distributeSelfERC20(cur);
                if (step == 0) realAmountIn = used;
            } else if (routeCommand == 2) {
                _distributeUserERC20(cur, declaredAmountIn);
            } else if (routeCommand == 3) {
                uint256 usedNative = _distributeNative(cur);
                if (step == 0) realAmountIn = usedNative;
            } else if (routeCommand == 4) {
                _dispatchSinglePoolSwap(cur);
            } else if (routeCommand == 5) {
                _applyPermit(tokenIn, cur);
            } else {
                revert UnknownCommandCode();
            }
            unchecked {
                ++step;
            }
        }
    }

    // ==== Private Functions ====

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

    /// @notice Distributes native ETH held by this contract across legs and dispatches swaps
    /// @dev Assumes ETH is already present on the contract
    /// @param cur The current position in the byte stream
    /// @return total The total amount of ETH to process
    function _distributeNative(uint256 cur) private returns (uint256 total) {
        total = address(this).balance;
        _distributeAndSwap(cur, address(this), LibAsset.NULL_ADDRESS, total);
    }

    /// @notice Distributes ERC20 tokens already on this contract
    /// @dev Includes protection against full balance draining
    /// @param cur The current position in the byte stream
    /// @return total The total amount of tokens to process
    function _distributeSelfERC20(
        uint256 cur
    ) private returns (uint256 total) {
        address token = cur.readAddress();
        total = IERC20(token).balanceOf(address(this));
        unchecked {
            // Prevent swaps with uselessly small amounts (like 1 wei) that could:
            // 1. Cause the entire transaction to fail (most DEXs reject such tiny trades)
            // 2. Waste gas even if they succeeded
            // By subtracting 1 from any positive balance, we ensure a balance of 1 becomes a swap amount of 0 (effectively skipping the swap)
            if (total > 0) total -= 1;
        }
        _distributeAndSwap(cur, address(this), token, total);
    }

    /// @notice Distributes ERC20 tokens from the caller
    /// @param cur The current position in the byte stream
    /// @param total The declared total to distribute from msg.sender
    function _distributeUserERC20(uint256 cur, uint256 total) private {
        address token = cur.readAddress();
        _distributeAndSwap(cur, msg.sender, token, total);
    }

    /// @notice Dispatches a single swap using tokens already in the pool
    /// @param cur The current position in the byte stream
    function _dispatchSinglePoolSwap(uint256 cur) private {
        address token = cur.readAddress();
        _dispatchSwap(cur, FUNDS_IN_RECEIVER, token, 0);
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
            uint256 remaining = total;
            for (uint256 i = 0; i < n; ++i) {
                uint16 share = cur.readUint16();
                uint256 amt = i == n - 1
                    ? remaining
                    : (total * share) / type(uint16).max; // compute vs original total
                if (amt > remaining) amt = remaining;
                remaining -= amt;
                _dispatchSwap(cur, from, tokenIn, amt);
            }
        }
    }

    /// @notice Dispatches a swap call to the appropriate DEX facet
    /// @dev Uses direct selector dispatch with optimized calldata construction
    ///      Assembly is used to:
    ///      - Build calldata for delegatecall without extra memory copies/abi.encode overhead
    ///      - Reuse the payload already read from the stream without re-encoding
    ///      - Keep memory usage predictable and cheap across arbitrary payload sizes
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
        // Read [selector | payload] blob for the specific DEX facet
        bytes memory data = cur.readBytesWithLength();

        // Extract function selector (first 4 bytes of data)
        bytes4 selector = _readSelector(data);

        // Compute payload length directly (data = [len | selector(4) | payload])

        uint256 payloadLen;
        assembly {
            payloadLen := sub(mload(data), 4)
        }

        address facet = LibDiamondLoupe.facetAddress(selector);
        if (facet == address(0)) revert UnknownSelector();

        bool success;
        bytes memory returnData;
        assembly {
            // Example: Building calldata for swapUniV3(bytes,address,address,uint256)
            // with example values:
            // - selector: 0x1234abcd
            // - from: 0xaaa...
            // - tokenIn: 0xbbb... (USDC)
            // - amountIn: 1000000 (1 USDC)
            // - swapData: abi.encode(
            //     pool: 0x123...,
            //     direction: 1,
            //     destinationAddress: 0x456...
            // )
            //
            // Memory layout it builds (each line is 32 bytes):
            // Position  Content
            // 0x80:     0x1234abcd00000000...  // selector
            // 0x84:     0x80                   // offset to swapData
            // 0xa4:     0xaaa...               // from address
            // 0xc4:     0xbbb...               // tokenIn address
            // 0xe4:     0x0f4240               // amountIn (1000000)
            // 0x104:    0x60                   // swapData length (96)
            // 0x124:    0x123...               // pool address
            // 0x144:    0x01                   // direction
            // 0x164:    0x456...               // destinationAddress

            // Free memory pointer where we’ll build calldata for delegatecall
            let free := mload(0x40)

            // Calldata layout we build:
            // [0..3]   function selector
            // [4..]    ABI-encoded args:
            //   head (4 words):
            //     word0: offset_to_payload (0x80 = after 4 static words)
            //     word1: from (address)
            //     word2: tokenIn (address)
            //     word3: amountIn (uint256)
            //   payload area:
            //     word4: payload.length
            //     word5+: payload bytes (padded to 32 bytes)

            // Write function selector
            mstore(free, selector)
            let args := add(free, 4)

            // Head: [offset_to_payload, from, tokenIn, amountIn]
            mstore(args, 0x80) // offset to payload data
            mstore(add(args, 0x20), from)
            mstore(add(args, 0x40), tokenIn)
            mstore(add(args, 0x60), amountIn)

            // Payload area (length + bytes)
            let d := add(args, 0x80)
            let len := payloadLen
            mstore(d, len)

            // Copy from data + 32 (skip length) + 4 (skip selector)
            // to = d+32; from = data+36; size = len
            pop(staticcall(gas(), 0x04, add(data, 36), len, add(d, 32), len))

            // Round payload length up to a multiple of 32 and compute total calldata size
            let padded := and(add(len, 31), not(31))
            // total = 4 (selector) + 0x80 (head) + 0x20 (payload length) + padded payload
            let total := add(4, add(0x80, add(0x20, padded)))

            // Perform delegatecall into facet.
            // delegatecall preserves msg.sender and storage context (diamond pattern).
            success := delegatecall(gas(), facet, free, total, 0, 0)

            // Advance the free memory pointer past our calldata buffer (even on failure).
            mstore(0x40, add(free, total))

            // Only allocate/copy return data on failure to save gas on success.
            switch success
            case 0 {
                let rsize := returndatasize()
                returnData := mload(0x40)
                mstore(returnData, rsize)
                let rptr := add(returnData, 32)
                returndatacopy(rptr, 0, rsize)
                // bump free memory pointer past the return data buffer (padded)
                mstore(0x40, add(rptr, and(add(rsize, 31), not(31))))
            }
        }

        // Bubble up revert data if delegatecall failed
        if (!success) {
            LibUtil.revertWith(returnData);
        }
    }

    // ==== Private Functions - Helpers ====

    /// @notice Extracts function selector from calldata
    /// @dev Assembly used to load the first 4 bytes (selector) directly from the bytes blob:
    ///      - bytes are laid out as [len (32 bytes) | data...]
    ///      - mload(add(blob, 32)) loads the first 32 bytes of data
    ///      - Solidity ABI selectors occupy the first 4 bytes
    /// @param blob The calldata bytes
    /// @return sel The extracted selector
    function _readSelector(
        bytes memory blob
    ) private pure returns (bytes4 sel) {
        assembly {
            sel := mload(add(blob, 32))
        }
    }

    /// @notice Creates a new bytes view that aliases blob without the first 4 bytes (selector)
    /// @dev Assembly used to:
    ///      - Point into the original bytes (no allocation/copy)
    ///      - Rewrite the length to exclude the 4-byte selector
    ///      This is safe here because we treat the result as a read-only slice.
    /// @param blob The original calldata bytes
    /// @return payload The calldata without selector
    function _payloadFrom(
        bytes memory blob
    ) private pure returns (bytes memory payload) {
        assembly {
            // payload points at blob + 4, sharing the same underlying buffer
            payload := add(blob, 4)
            // set payload.length = blob.length - 4
            mstore(payload, sub(mload(blob), 4))
        }
    }
}
