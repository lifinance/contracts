// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.17;

import { SafeERC20, IERC20, IERC20Permit } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { SafeTransferLib } from "solady/utils/SafeTransferLib.sol";
import { WithdrawablePeriphery } from "lifi/Helpers/WithdrawablePeriphery.sol";
import { IVelodromeV2Pool } from "lifi/Interfaces/IVelodromeV2Pool.sol";
import { IAlgebraPool } from "lifi/Interfaces/IAlgebraPool.sol";
import { IiZiSwapPool } from "lifi/Interfaces/IiZiSwapPool.sol";
import { InvalidConfig, InvalidCallData } from "lifi/Errors/GenericErrors.sol";

address constant NATIVE_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
address constant IMPOSSIBLE_POOL_ADDRESS = 0x0000000000000000000000000000000000000001;
address constant INTERNAL_INPUT_SOURCE = 0x0000000000000000000000000000000000000000;

uint8 constant LOCKED = 2;
uint8 constant NOT_LOCKED = 1;
uint8 constant PAUSED = 2;
uint8 constant NOT_PAUSED = 1;

/// @dev The minimum value that can be returned from #getSqrtRatioAtTick. Equivalent to getSqrtRatioAtTick(MIN_TICK)
uint160 constant MIN_SQRT_RATIO = 4295128739;
/// @dev The maximum value that can be returned from #getSqrtRatioAtTick. Equivalent to getSqrtRatioAtTick(MAX_TICK)
uint160 constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

/// @dev iZiSwap pool price points boundaries
int24 constant IZUMI_LEFT_MOST_PT = -800000;
int24 constant IZUMI_RIGHT_MOST_PT = 800000;

uint8 constant DIRECTION_TOKEN0_TO_TOKEN1 = 1;
uint8 constant CALLBACK_ENABLED = 1;

/// @dev Pool type identifiers used to determine which DEX protocol to interact with during swaps
uint8 constant POOL_TYPE_UNIV2 = 0;
uint8 constant POOL_TYPE_UNIV3 = 1;
uint8 constant POOL_TYPE_WRAP_NATIVE = 2;
uint8 constant POOL_TYPE_BENTO_BRIDGE = 3;
uint8 constant POOL_TYPE_TRIDENT = 4;
uint8 constant POOL_TYPE_CURVE = 5;
uint8 constant POOL_TYPE_VELODROME_V2 = 6;
uint8 constant POOL_TYPE_ALGEBRA = 7;
uint8 constant POOL_TYPE_IZUMI_V3 = 8;

/// @title LiFi DEX Aggregator
/// @author Ilya Lyalin (contract copied from: https://github.com/sushiswap/sushiswap/blob/c8c80dec821003eb72eb77c7e0446ddde8ca9e1e/protocols/route-processor/contracts/RouteProcessor4.sol)
/// @notice Processes calldata to swap using various DEXs
/// @custom:version 1.10.0
contract LiFiDEXAggregator is WithdrawablePeriphery {
    using SafeERC20 for IERC20;
    using Approve for IERC20;
    using SafeERC20 for IERC20Permit;
    using InputStream for uint256;

    event Route(
        address indexed from,
        address to,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 amountOut
    );

    error MinimalOutputBalanceViolation(uint256 amountOut);
    error RouteProcessorLocked();
    error RouteProcessorPaused();
    error CallerNotOwnerOrPriviledged();
    error UnknownCommandCode();
    error UnknownPoolType();
    error MinimalInputBalanceViolation(uint256 available, uint256 required);
    error UniswapV3SwapUnexpected();
    error UniswapV3SwapCallbackUnknownSource();
    error UniswapV3SwapCallbackNotPositiveAmount();
    error WrongPoolReserves();
    error AlgebraSwapUnexpected();
    error IzumiV3SwapUnexpected();
    error IzumiV3SwapCallbackUnknownSource();
    error IzumiV3SwapCallbackNotPositiveAmount();

    IBentoBoxMinimal public immutable BENTO_BOX;
    mapping(address => bool) public priviledgedUsers;
    address private lastCalledPool;

    uint8 private unlocked = NOT_LOCKED;
    uint8 private paused = NOT_PAUSED;
    modifier lock() {
        if (unlocked != NOT_LOCKED) revert RouteProcessorLocked();
        if (paused != NOT_PAUSED) revert RouteProcessorPaused();
        unlocked = LOCKED;
        _;
        unlocked = NOT_LOCKED;
    }

    modifier onlyOwnerOrPriviledgedUser() {
        if (!(msg.sender == owner || priviledgedUsers[msg.sender]))
            revert CallerNotOwnerOrPriviledged();
        _;
    }

    constructor(
        address _bentoBox,
        address[] memory priviledgedUserList,
        address _owner
    ) WithdrawablePeriphery(_owner) {
        if (_owner == address(0)) {
            revert InvalidConfig();
        }
        BENTO_BOX = IBentoBoxMinimal(_bentoBox);
        lastCalledPool = IMPOSSIBLE_POOL_ADDRESS;

        for (uint256 i = 0; i < priviledgedUserList.length; i++) {
            priviledgedUsers[priviledgedUserList[i]] = true;
        }
    }

    function setPriviledge(address user, bool priviledge) external onlyOwner {
        priviledgedUsers[user] = priviledge;
    }

    function pause() external onlyOwnerOrPriviledgedUser {
        paused = PAUSED;
    }

    function resume() external onlyOwnerOrPriviledgedUser {
        paused = NOT_PAUSED;
    }

    /// @notice For native unwrapping
    receive() external payable {}

    /// @notice Processes the route generated off-chain. Has a lock
    /// @param tokenIn Address of the input token
    /// @param amountIn Amount of the input token
    /// @param tokenOut Address of the output token
    /// @param amountOutMin Minimum amount of the output token
    /// @return amountOut Actual amount of the output token
    function processRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes memory route
    ) external payable lock returns (uint256 amountOut) {
        return
            processRouteInternal(
                tokenIn,
                amountIn,
                tokenOut,
                amountOutMin,
                to,
                route
            );
    }

    /// @notice Transfers some value to <transferValueTo> and then processes the route
    /// @param transferValueTo Address where the value should be transferred
    /// @param amountValueTransfer How much value to transfer
    /// @param tokenIn Address of the input token
    /// @param amountIn Amount of the input token
    /// @param tokenOut Address of the output token
    /// @param amountOutMin Minimum amount of the output token
    /// @return amountOut Actual amount of the output token
    function transferValueAndprocessRoute(
        address payable transferValueTo,
        uint256 amountValueTransfer,
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes memory route
    ) external payable lock returns (uint256 amountOut) {
        SafeTransferLib.safeTransferETH(transferValueTo, amountValueTransfer);
        return
            processRouteInternal(
                tokenIn,
                amountIn,
                tokenOut,
                amountOutMin,
                to,
                route
            );
    }

    /// @notice Processes the route generated off-chain
    /// @param tokenIn Address of the input token
    /// @param amountIn Amount of the input token
    /// @param tokenOut Address of the output token
    /// @param amountOutMin Minimum amount of the output token
    /// @return amountOut Actual amount of the output token
    function processRouteInternal(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 amountOutMin,
        address to,
        bytes memory route
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
            uint256 stream = InputStream.createStream(route);
            while (stream.isNotEmpty()) {
                uint8 commandCode = stream.readUint8();
                if (commandCode == 1) {
                    uint256 usedAmount = processMyERC20(stream);
                    if (step == 0) realAmountIn = usedAmount;
                } else if (commandCode == 2)
                    processUserERC20(stream, amountIn);
                else if (commandCode == 3) {
                    uint256 usedAmount = processNative(stream);
                    if (step == 0) realAmountIn = usedAmount;
                } else if (commandCode == 4) processOnePool(stream);
                else if (commandCode == 5) processInsideBento(stream);
                else if (commandCode == 6) applyPermit(tokenIn, stream);
                else revert UnknownCommandCode();
                ++step;
            }
        }

        uint256 balanceInFinal = tokenIn == NATIVE_ADDRESS
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);
        if (balanceInFinal + amountIn < balanceInInitial)
            revert MinimalInputBalanceViolation(
                balanceInFinal + amountIn,
                balanceInInitial
            );

        uint256 balanceOutFinal = tokenOut == NATIVE_ADDRESS
            ? address(to).balance
            : IERC20(tokenOut).balanceOf(to);
        if (balanceOutFinal < balanceOutInitial + amountOutMin)
            revert MinimalOutputBalanceViolation(
                balanceOutFinal - balanceOutInitial
            );

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
    /// @param tokenIn permitted token
    /// @param stream Streamed program
    function applyPermit(address tokenIn, uint256 stream) private {
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

    /// @notice Processes native coin: call swap for all pools that swap from native coin
    /// @param stream Streamed program
    function processNative(
        uint256 stream
    ) private returns (uint256 amountTotal) {
        amountTotal = address(this).balance;
        distributeAndSwap(stream, address(this), NATIVE_ADDRESS, amountTotal);
    }

    /// @notice Processes ERC20 token from this contract balance:
    /// @notice Call swap for all pools that swap from this token
    /// @param stream Streamed program
    function processMyERC20(
        uint256 stream
    ) private returns (uint256 amountTotal) {
        address token = stream.readAddress();
        amountTotal = IERC20(token).balanceOf(address(this));
        unchecked {
            if (amountTotal > 0) amountTotal -= 1; // slot undrain protection
        }
        distributeAndSwap(stream, address(this), token, amountTotal);
    }

    /// @notice Processes ERC20 token from msg.sender balance:
    /// @notice Call swap for all pools that swap from this token
    /// @param stream Streamed program
    /// @param amountTotal Amount of tokens to take from msg.sender
    function processUserERC20(uint256 stream, uint256 amountTotal) private {
        address token = stream.readAddress();
        distributeAndSwap(stream, msg.sender, token, amountTotal);
    }

    /// @notice Processes ERC20 token for cases when the token has only one output pool
    /// @notice In this case liquidity is already at pool balance. This is an optimization
    /// @notice Call swap for all pools that swap from this token
    /// @dev WARNING: This function passes amountIn as 0 which may not work with some UniswapV3
    /// @dev forks that require non-zero amounts for their pricing/slippage calculations.
    /// @dev Use with caution for V3-style pools.
    /// @param stream Streamed program
    function processOnePool(uint256 stream) private {
        address token = stream.readAddress();
        swap(stream, INTERNAL_INPUT_SOURCE, token, 0);
    }

    /// @notice Processes Bento tokens
    /// @notice Call swap for all pools that swap from this token
    /// @param stream Streamed program
    function processInsideBento(uint256 stream) private {
        address token = stream.readAddress();
        uint256 amountTotal = BENTO_BOX.balanceOf(token, address(this));
        unchecked {
            if (amountTotal > 0) amountTotal -= 1; // slot undrain protection
        }
        distributeAndSwap(stream, address(this), token, amountTotal);
    }

    /// @notice Distributes amountTotal to several pools according to their shares and calls swap for each pool
    /// @param stream Streamed program
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountTotal Total amount of tokenIn for swaps
    function distributeAndSwap(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountTotal
    ) private {
        uint8 num = stream.readUint8();
        unchecked {
            for (uint256 i = 0; i < num; ++i) {
                uint16 share = stream.readUint16();
                uint256 amount = (amountTotal * share) /
                    type(uint16).max /*65535*/;
                amountTotal -= amount;
                swap(stream, from, tokenIn, amount);
            }
        }
    }

    /// @notice Makes swap
    /// @param stream Streamed program
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swap(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        uint8 poolType = stream.readUint8();
        if (poolType == POOL_TYPE_UNIV2)
            swapUniV2(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_UNIV3)
            swapUniV3(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_WRAP_NATIVE)
            wrapNative(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_BENTO_BRIDGE)
            bentoBridge(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_TRIDENT)
            swapTrident(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_CURVE)
            swapCurve(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_VELODROME_V2)
            swapVelodromeV2(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_ALGEBRA)
            swapAlgebra(stream, from, tokenIn, amountIn);
        else if (poolType == POOL_TYPE_IZUMI_V3)
            swapIzumiV3(stream, from, tokenIn, amountIn);
        else revert UnknownPoolType();
    }

    /// @notice Wraps/unwraps native token
    /// @param stream [direction & fake, recipient, wrapToken?]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function wrapNative(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        uint8 directionAndFake = stream.readUint8();
        address to = stream.readAddress();

        if (directionAndFake & 1 == 1) {
            // wrap native
            address wrapToken = stream.readAddress();
            if (directionAndFake & 2 == 0)
                IWETH(wrapToken).deposit{ value: amountIn }();
            if (to != address(this))
                IERC20(wrapToken).safeTransfer(to, amountIn);
        } else {
            // unwrap native
            if (directionAndFake & 2 == 0) {
                if (from == msg.sender)
                    IERC20(tokenIn).safeTransferFrom(
                        msg.sender,
                        address(this),
                        amountIn
                    );
                IWETH(tokenIn).withdraw(amountIn);
            }
            SafeTransferLib.safeTransferETH(to, amountIn);
        }
    }

    /// @notice Bridge/unbridge tokens to/from Bento
    /// @param stream [direction, recipient]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function bentoBridge(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        uint8 direction = stream.readUint8();
        address to = stream.readAddress();

        if (direction > 0) {
            // outside to Bento
            // deposit to arbitrary recipient is possible only from address(BENTO_BOX)
            if (from == address(this))
                IERC20(tokenIn).safeTransfer(address(BENTO_BOX), amountIn);
            else if (from == msg.sender)
                IERC20(tokenIn).safeTransferFrom(
                    msg.sender,
                    address(BENTO_BOX),
                    amountIn
                );
            else {
                // tokens already are at address(BENTO_BOX)
                amountIn =
                    IERC20(tokenIn).balanceOf(address(BENTO_BOX)) +
                    BENTO_BOX.strategyData(tokenIn).balance -
                    BENTO_BOX.totals(tokenIn).elastic;
            }
            BENTO_BOX.deposit(tokenIn, address(BENTO_BOX), to, amountIn, 0);
        } else {
            // Bento to outside
            if (from != INTERNAL_INPUT_SOURCE) {
                BENTO_BOX.transfer(tokenIn, from, address(this), amountIn);
            } else amountIn = BENTO_BOX.balanceOf(tokenIn, address(this));
            BENTO_BOX.withdraw(tokenIn, address(this), to, 0, amountIn);
        }
    }

    /// @notice UniswapV2 pool swap
    /// @param stream [pool, direction, recipient, fee]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapUniV2(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        address pool = stream.readAddress();
        uint8 direction = stream.readUint8();
        address to = stream.readAddress();
        uint24 fee = stream.readUint24(); // pool fee in 1/1_000_000

        if (from == address(this))
            IERC20(tokenIn).safeTransfer(pool, amountIn);
        else if (from == msg.sender)
            IERC20(tokenIn).safeTransferFrom(msg.sender, pool, amountIn);

        (uint256 r0, uint256 r1, ) = IUniswapV2Pair(pool).getReserves();
        if (r0 == 0 || r1 == 0) revert WrongPoolReserves();
        (uint256 reserveIn, uint256 reserveOut) = direction ==
            DIRECTION_TOKEN0_TO_TOKEN1
            ? (r0, r1)
            : (r1, r0);
        amountIn = IERC20(tokenIn).balanceOf(pool) - reserveIn; // tokens already were transferred

        uint256 amountInWithFee = amountIn * (1_000_000 - fee);
        uint256 amountOut = (amountInWithFee * reserveOut) /
            (reserveIn * 1_000_000 + amountInWithFee);
        (uint256 amount0Out, uint256 amount1Out) = direction ==
            DIRECTION_TOKEN0_TO_TOKEN1
            ? (uint256(0), amountOut)
            : (amountOut, uint256(0));
        IUniswapV2Pair(pool).swap(amount0Out, amount1Out, to, new bytes(0));
    }

    /// @notice Trident pool swap
    /// @param stream [pool, swapData]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapTrident(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        address pool = stream.readAddress();
        bytes memory swapData = stream.readBytes();

        if (from != INTERNAL_INPUT_SOURCE) {
            BENTO_BOX.transfer(tokenIn, from, pool, amountIn);
        }

        IPool(pool).swap(swapData);
    }

    /// @notice UniswapV3 pool swap
    /// @param stream [pool, direction, recipient]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapUniV3(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        address pool = stream.readAddress();
        bool direction = stream.readUint8() > 0;
        address recipient = stream.readAddress();

        if (
            pool == address(0) ||
            pool == IMPOSSIBLE_POOL_ADDRESS ||
            recipient == address(0)
        ) revert InvalidCallData();

        if (from == msg.sender)
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                uint256(amountIn)
            );

        lastCalledPool = pool;
        IUniswapV3Pool(pool).swap(
            recipient,
            direction,
            int256(amountIn),
            direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn)
        );
        if (lastCalledPool != IMPOSSIBLE_POOL_ADDRESS)
            revert UniswapV3SwapUnexpected(); // Just to be sure
    }

    /// @notice Called to `msg.sender` after executing a swap via IUniswapV3Pool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method must be checked to be a UniswapV3Pool deployed by the canonical UniswapV3Factory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IUniswapV3PoolActions#swap call
    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) public {
        if (msg.sender != lastCalledPool)
            revert UniswapV3SwapCallbackUnknownSource();
        int256 amount = amount0Delta > 0 ? amount0Delta : amount1Delta;
        if (amount <= 0) revert UniswapV3SwapCallbackNotPositiveAmount();

        lastCalledPool = IMPOSSIBLE_POOL_ADDRESS;
        address tokenIn = abi.decode(data, (address));
        IERC20(tokenIn).safeTransfer(msg.sender, uint256(amount));
    }

    /// @notice Called to `msg.sender` after executing a swap via IAlgebraPool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method _must_ be checked to be a AlgebraPool deployed by the canonical AlgebraFactory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IAlgebraPoolActions#swap call
    function algebraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via PancakeV3Pool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the PancakeV3Pool#swap call
    function pancakeV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via RaExchangeV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the RaExchangeV3#swap call
    function ramsesV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via XeiV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the XeiV3#swap call
    function xeiV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via DragonSwapV2#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the DragonSwapV2#swap call
    function dragonswapV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via AgniV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the AgniV3#swap call
    function agniSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via FusionXV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the FusionXV3#swap call
    function fusionXV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via VVS FinanceV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the VVS Finance V3#swap call
    function vvsV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via SupSwapV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the SupSwapV3#swap call
    function supV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via ZebraV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the ZebraV3#swap call
    function zebraV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Performs a swap through iZiSwap V3 pools
    /// @dev This function handles both X to Y and Y to X swaps through iZiSwap V3 pools
    /// @param stream [pool, direction, to]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapIzumiV3(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        address pool = stream.readAddress();
        uint8 direction = stream.readUint8(); // 0 = Y2X, 1 = X2Y
        address to = stream.readAddress();

        // Handle token transfer
        if (from == msg.sender) {
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                amountIn
            );
        }

        lastCalledPool = pool;

        // Execute swap - we need both amounts for the Swap event
        if (direction == DIRECTION_TOKEN0_TO_TOKEN1) {
            IiZiSwapPool(pool).swapX2Y(
                to,
                uint128(amountIn),
                IZUMI_LEFT_MOST_PT,
                abi.encode(tokenIn)
            );
        } else {
            IiZiSwapPool(pool).swapY2X(
                to,
                uint128(amountIn),
                IZUMI_RIGHT_MOST_PT,
                abi.encode(tokenIn)
            );
        }

        if (lastCalledPool != IMPOSSIBLE_POOL_ADDRESS) {
            revert IzumiV3SwapUnexpected();
        }
    }

    /// @dev Common logic for iZiSwap callbacks
    /// @param amountToPay The amount of tokens to be sent to the pool
    /// @param data The data passed through by the caller
    function _handleIzumiV3SwapCallback(
        uint256 amountToPay,
        bytes calldata data
    ) private {
        if (msg.sender != lastCalledPool) {
            revert IzumiV3SwapCallbackUnknownSource();
        }

        address tokenIn = abi.decode(data, (address));

        if (amountToPay <= 0) {
            revert IzumiV3SwapCallbackNotPositiveAmount();
        }

        lastCalledPool = IMPOSSIBLE_POOL_ADDRESS;
        IERC20(tokenIn).safeTransfer(msg.sender, amountToPay);
    }

    /// @notice Called to `msg.sender` after executing a swap via IiZiSwapPool#swapX2Y
    /// @dev In the implementation you must pay the pool tokens owed for the swap
    /// @dev The caller of this method must be checked to be an iZiSwap pool deployed by the canonical iZiSwap factory
    /// @param amountX The amount of tokenX that must be sent to the pool by the end of the swap
    /// @param amountY The amount of tokenY that was sent by the pool in the swap
    /// @param data Any data passed through by the caller via the IiZiSwapPool#swapX2Y call
    function swapX2YCallback(
        uint256 amountX,
        // solhint-disable-next-line no-unused-vars
        uint256 amountY,
        bytes calldata data
    ) external {
        _handleIzumiV3SwapCallback(amountX, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via IiZiSwapPool#swapY2X
    /// @dev In the implementation you must pay the pool tokens owed for the swap
    /// @dev The caller of this method must be checked to be an iZiSwap pool deployed by the canonical iZiSwap factory
    /// @param amountX The amount of tokenX that was sent by the pool in the swap
    /// @param amountY The amount of tokenY that must be sent to the pool by the end of the swap
    /// @param data Any data passed through by the caller via the IiZiSwapPool#swapY2X call
    function swapY2XCallback(
        // solhint-disable-next-line no-unused-vars
        uint256 amountX,
        uint256 amountY,
        bytes calldata data
    ) external {
        // In swapY2X, we're swapping from tokenY to tokenX
        // The pool will expect us to transfer the tokenY amount
        _handleIzumiV3SwapCallback(amountY, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via HyperswapV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the HyperswapV3#swap call
    function hyperswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via LaminarV3#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the LaminarV3#swap call
    function laminarV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via IXSwapPool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method must be checked to be a XSwapPool deployed by the canonical XSwapFactory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IXSwapPoolActions#swap call
    function xswapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via IRabbitSwapV3Pool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method must be checked to be a RabbitSwapV3Pool deployed by the canonical RabbitSwapV3Factory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IRabbitSwapV3PoolActions#swap call
    function rabbitSwapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Called to `msg.sender` after executing a swap via IEnosysDexV3Pool#swap.
    /// @dev In the implementation you must pay the pool tokens owed for the swap.
    /// The caller of this method must be checked to be a EnosysDexV3Pool deployed by the canonical EnosysDexV3Factory.
    /// amount0Delta and amount1Delta can both be 0 if no tokens were swapped.
    /// @param amount0Delta The amount of token0 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token0 to the pool.
    /// @param amount1Delta The amount of token1 that was sent (negative) or must be received (positive) by the pool by
    /// the end of the swap. If positive, the callback must send that amount of token1 to the pool.
    /// @param data Any data passed through by the caller via the IEnosysDexV3PoolActions#swap call
    function enosysdexV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata data
    ) external {
        uniswapV3SwapCallback(amount0Delta, amount1Delta, data);
    }

    /// @notice Curve pool swap. Legacy pools that don't return amountOut and have native coins are not supported
    /// @param stream [pool, poolType, fromIndex, toIndex, recipient, output token]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapCurve(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        address pool = stream.readAddress();
        uint8 poolType = stream.readUint8();
        int128 fromIndex = int8(stream.readUint8());
        int128 toIndex = int8(stream.readUint8());
        address to = stream.readAddress();
        address tokenOut = stream.readAddress();

        uint256 amountOut;
        if (tokenIn == NATIVE_ADDRESS) {
            amountOut = ICurve(pool).exchange{ value: amountIn }(
                fromIndex,
                toIndex,
                amountIn,
                0
            );
        } else {
            if (from == msg.sender)
                IERC20(tokenIn).safeTransferFrom(
                    msg.sender,
                    address(this),
                    amountIn
                );
            IERC20(tokenIn).approveSafe(pool, amountIn);
            if (poolType == 0)
                amountOut = ICurve(pool).exchange(
                    fromIndex,
                    toIndex,
                    amountIn,
                    0
                );
            else {
                uint256 balanceBefore = IERC20(tokenOut).balanceOf(
                    address(this)
                );
                ICurveLegacy(pool).exchange(fromIndex, toIndex, amountIn, 0);
                uint256 balanceAfter = IERC20(tokenOut).balanceOf(
                    address(this)
                );
                amountOut = balanceAfter - balanceBefore;
            }
        }

        if (to != address(this)) {
            if (tokenOut == NATIVE_ADDRESS) {
                SafeTransferLib.safeTransferETH(to, amountOut);
            } else {
                IERC20(tokenOut).safeTransfer(to, amountOut);
            }
        }
    }

    /// @notice Performs a swap through VelodromeV2 pools
    /// @dev This function does not handle native token swaps directly, so processNative command cannot be used
    /// @param stream [pool, direction, to, callback]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    function swapVelodromeV2(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        address pool = stream.readAddress();
        uint8 direction = stream.readUint8();
        address to = stream.readAddress();
        if (pool == address(0) || to == address(0)) revert InvalidCallData();
        bool callback = stream.readUint8() == CALLBACK_ENABLED; // if true then run callback after swap with tokenIn as flashloan data. Will revert if contract (to) does not implement IVelodromeV2PoolCallee

        if (from == INTERNAL_INPUT_SOURCE) {
            (uint256 reserve0, uint256 reserve1, ) = IVelodromeV2Pool(pool)
                .getReserves();
            if (reserve0 == 0 || reserve1 == 0) revert WrongPoolReserves();
            uint256 reserveIn = direction == DIRECTION_TOKEN0_TO_TOKEN1
                ? reserve0
                : reserve1;

            amountIn = IERC20(tokenIn).balanceOf(pool) - reserveIn;
        } else {
            if (from == address(this))
                IERC20(tokenIn).safeTransfer(pool, amountIn);
            else if (from == msg.sender)
                IERC20(tokenIn).safeTransferFrom(msg.sender, pool, amountIn);
        }

        // calculate the expected output amount using the pool's getAmountOut function
        uint256 amountOut = IVelodromeV2Pool(pool).getAmountOut(
            amountIn,
            tokenIn
        );

        // set the appropriate output amount based on which token is being swapped
        // determine output amounts based on direction
        uint256 amount0Out = direction == DIRECTION_TOKEN0_TO_TOKEN1
            ? 0
            : amountOut;
        uint256 amount1Out = direction == DIRECTION_TOKEN0_TO_TOKEN1
            ? amountOut
            : 0;

        // 'swap' function from IVelodromeV2Pool should be called from a contract which performs important safety checks.
        // Safety Checks Covered:
        // - Reentrancy: LDA has a custom lock() modifier
        // - Token transfer safety: SafeERC20 is used to ensure token transfers revert on failure
        // - Expected output verification: The contract calls getAmountOut (including fees) before executing the swap
        // - Flashloan trigger: A flashloan flag is used to determine if the callback should be triggered
        // - Post-swap verification: In processRouteInternal, it verifies that the recipient receives at least minAmountOut and that the sender's final balance is not less than the initial balance
        // - Immutable interaction: Velodrome V2 pools and the router are not upgradable, so we can rely on the behavior of getAmountOut and swap

        // ATTENTION FOR CALLBACKS / HOOKS:
        // - recipient contracts should validate that msg.sender is the Velodrome pool contract who is calling the hook
        // - recipient contracts must not manipulate their own tokenOut balance (as this may bypass/invalidate the built-in slippage protection)
        // - @developers: never trust balance-based slippage protection for callback recipients
        // - @integrators: do not use slippage guarantees when recipient is a contract with side-effects
        IVelodromeV2Pool(pool).swap(
            amount0Out,
            amount1Out,
            to,
            callback ? abi.encode(tokenIn) : bytes("")
        );
    }

    /// @notice Algebra pool swap
    /// @param stream [pool, direction, recipient, supportsFeeOnTransfer]
    /// @param from Where to take liquidity for swap
    /// @param tokenIn Input token
    /// @param amountIn Amount of tokenIn to take for swap
    /// @dev The supportsFeeOnTransfer flag accepts any non-zero value (1-255) to enable fee-on-transfer handling.
    /// When enabled, the swap will first attempt to use swapSupportingFeeOnInputTokens(), and if that fails,
    /// it will fall back to the regular swap() function. A value of 0 disables fee-on-transfer handling.
    function swapAlgebra(
        uint256 stream,
        address from,
        address tokenIn,
        uint256 amountIn
    ) private {
        address pool = stream.readAddress();
        bool direction = stream.readUint8() == DIRECTION_TOKEN0_TO_TOKEN1; // direction indicates the swap direction: true for token0 -> token1, false for token1 -> token0
        address recipient = stream.readAddress();
        bool supportsFeeOnTransfer = stream.readUint8() > 0; // Any non-zero value enables fee-on-transfer handling

        if (
            pool == address(0) ||
            pool == IMPOSSIBLE_POOL_ADDRESS ||
            recipient == address(0)
        ) revert InvalidCallData();

        if (from == msg.sender)
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                uint256(amountIn)
            );

        lastCalledPool = pool;

        // Handle fee-on-transfer tokens with special care:
        // - These tokens modify balances during transfer (fees, rebasing, etc.)
        // - newest pool of Algebra versions has built-in support via swapSupportingFeeOnInputTokens()
        // - Unlike UniswapV3, Algebra can safely handle these non-standard tokens.
        if (supportsFeeOnTransfer) {
            // If the pool is not using a version of Algebra that supports this feature, the swap will revert
            // when attempting to use swapSupportingFeeOnInputTokens(), indicating the token was incorrectly
            // flagged as fee-on-transfer or the pool doesn't support such tokens.
            IAlgebraPool(pool).swapSupportingFeeOnInputTokens(
                address(this),
                recipient,
                direction,
                int256(amountIn),
                direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(tokenIn)
            );
        } else {
            IAlgebraPool(pool).swap(
                recipient,
                direction,
                int256(amountIn),
                direction ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
                abi.encode(tokenIn)
            );
        }

        if (lastCalledPool != IMPOSSIBLE_POOL_ADDRESS)
            revert AlgebraSwapUnexpected();
    }
}

/// @notice Minimal BentoBox vault interface.
/// @dev `token` is aliased as `address` from `IERC20` for simplicity.
interface IBentoBoxMinimal {
    /// @notice Balance per ERC-20 token per account in shares.
    function balanceOf(address, address) external view returns (uint256);

    /// @dev Helper function to represent an `amount` of `token` in shares.
    /// @param token The ERC-20 token.
    /// @param amount The `token` amount.
    /// @param roundUp If the result `share` should be rounded up.
    /// @return share The token amount represented in shares.
    function toShare(
        address token,
        uint256 amount,
        bool roundUp
    ) external view returns (uint256 share);

    /// @dev Helper function to represent shares back into the `token` amount.
    /// @param token The ERC-20 token.
    /// @param share The amount of shares.
    /// @param roundUp If the result should be rounded up.
    /// @return amount The share amount back into native representation.
    function toAmount(
        address token,
        uint256 share,
        bool roundUp
    ) external view returns (uint256 amount);

    /// @notice Registers this contract so that users can approve it for BentoBox.
    function registerProtocol() external;

    /// @notice Deposit an amount of `token` represented in either `amount` or `share`.
    /// @param token The ERC-20 token to deposit.
    /// @param from which account to pull the tokens.
    /// @param to which account to push the tokens.
    /// @param amount Token amount in native representation to deposit.
    /// @param share Token amount represented in shares to deposit. Takes precedence over `amount`.
    /// @return amountOut The amount deposited.
    /// @return shareOut The deposited amount represented in shares.
    function deposit(
        address token,
        address from,
        address to,
        uint256 amount,
        uint256 share
    ) external payable returns (uint256 amountOut, uint256 shareOut);

    /// @notice Withdraws an amount of `token` from a user account.
    /// @param token_ The ERC-20 token to withdraw.
    /// @param from which user to pull the tokens.
    /// @param to which user to push the tokens.
    /// @param amount of tokens. Either one of `amount` or `share` needs to be supplied.
    /// @param share Like above, but `share` takes precedence over `amount`.
    function withdraw(
        address token_,
        address from,
        address to,
        uint256 amount,
        uint256 share
    ) external returns (uint256 amountOut, uint256 shareOut);

    /// @notice Transfer shares from a user account to another one.
    /// @param token The ERC-20 token to transfer.
    /// @param from which user to pull the tokens.
    /// @param to which user to push the tokens.
    /// @param share The amount of `token` in shares.
    function transfer(
        address token,
        address from,
        address to,
        uint256 share
    ) external;

    /// @dev Reads the Rebase `totals`from storage for a given token
    function totals(address token) external view returns (Rebase memory total);

    function strategyData(
        address token
    ) external view returns (StrategyData memory total);

    /// @dev Approves users' BentoBox assets to a "master" contract.
    function setMasterContractApproval(
        address user,
        address masterContract,
        bool approved,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function harvest(
        address token,
        bool balance,
        uint256 maxChangeAmount
    ) external;
}

interface ICurve {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        // solhint-disable-next-line var-name-mixedcase
        uint256 min_dy
    ) external payable returns (uint256);
}

interface ICurveLegacy {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        // solhint-disable-next-line var-name-mixedcase
        uint256 min_dy
    ) external payable;
}

/// @notice Trident pool interface.
interface IPool {
    /// @notice Executes a swap from one token to another.
    /// @dev The input tokens must've already been sent to the pool.
    /// @param data ABI-encoded params that the pool requires.
    /// @return finalAmountOut The amount of output tokens that were sent to the user.
    function swap(
        bytes calldata data
    ) external returns (uint256 finalAmountOut);

    /// @notice Executes a swap from one token to another with a callback.
    /// @dev This function allows borrowing the output tokens and sending the input tokens in the callback.
    /// @param data ABI-encoded params that the pool requires.
    /// @return finalAmountOut The amount of output tokens that were sent to the user.
    function flashSwap(
        bytes calldata data
    ) external returns (uint256 finalAmountOut);

    /// @notice Mints liquidity tokens.
    /// @param data ABI-encoded params that the pool requires.
    /// @return liquidity The amount of liquidity tokens that were minted for the user.
    function mint(bytes calldata data) external returns (uint256 liquidity);

    /// @notice Burns liquidity tokens.
    /// @dev The input LP tokens must've already been sent to the pool.
    /// @param data ABI-encoded params that the pool requires.
    /// @return withdrawnAmounts The amount of various output tokens that were sent to the user.
    function burn(
        bytes calldata data
    ) external returns (TokenAmount[] memory withdrawnAmounts);

    /// @notice Burns liquidity tokens for a single output token.
    /// @dev The input LP tokens must've already been sent to the pool.
    /// @param data ABI-encoded params that the pool requires.
    /// @return amountOut The amount of output tokens that were sent to the user.
    function burnSingle(
        bytes calldata data
    ) external returns (uint256 amountOut);

    /// @return A unique identifier for the pool type.
    function poolIdentifier() external pure returns (bytes32);

    /// @return An array of tokens supported by the pool.
    function getAssets() external view returns (address[] memory);

    /// @notice Simulates a trade and returns the expected output.
    /// @dev The pool does not need to include a trade simulator directly in itself - it can use a library.
    /// @param data ABI-encoded params that the pool requires.
    /// @return finalAmountOut The amount of output tokens that will be sent to the user if the trade is executed.
    function getAmountOut(
        bytes calldata data
    ) external view returns (uint256 finalAmountOut);

    /// @notice Simulates a trade and returns the expected output.
    /// @dev The pool does not need to include a trade simulator directly in itself - it can use a library.
    /// @param data ABI-encoded params that the pool requires.
    /// @return finalAmountIn The amount of input tokens that are required from the user if the trade is executed.
    function getAmountIn(
        bytes calldata data
    ) external view returns (uint256 finalAmountIn);

    /// @dev This event must be emitted on all swaps.
    event Swap(
        address indexed recipient,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    /// @dev This struct frames output tokens for burns.
    struct TokenAmount {
        address token;
        uint256 amount;
    }
}

interface ITridentCLPool {
    function token0() external returns (address);

    function token1() external returns (address);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bool unwrapBento,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IUniswapV2Pair {
    event Approval(
        address indexed owner,
        address indexed spender,
        uint256 value
    );
    event Transfer(address indexed from, address indexed to, uint256 value);

    function name() external pure returns (string memory);

    function symbol() external pure returns (string memory);

    function decimals() external pure returns (uint8);

    function totalSupply() external view returns (uint256);

    function balanceOf(address owner) external view returns (uint256);

    function allowance(
        address owner,
        address spender
    ) external view returns (uint256);

    function approve(address spender, uint256 value) external returns (bool);

    function transfer(address to, uint256 value) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) external returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function PERMIT_TYPEHASH() external pure returns (bytes32);

    function nonces(address owner) external view returns (uint256);

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Burn(
        address indexed sender,
        uint256 amount0,
        uint256 amount1,
        address indexed to
    );
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    function MINIMUM_LIQUIDITY() external pure returns (uint256);

    function factory() external view returns (address);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function getReserves()
        external
        view
        returns (
            uint112 reserve0,
            uint112 reserve1,
            uint32 blockTimestampLast
        );

    function price0CumulativeLast() external view returns (uint256);

    function price1CumulativeLast() external view returns (uint256);

    function kLast() external view returns (uint256);

    function mint(address to) external returns (uint256 liquidity);

    function burn(
        address to
    ) external returns (uint256 amount0, uint256 amount1);

    function swap(
        uint256 amount0Out,
        uint256 amount1Out,
        address to,
        bytes calldata data
    ) external;

    function skim(address to) external;

    function sync() external;

    function initialize(address, address) external;
}

interface IUniswapV3Pool {
    function token0() external returns (address);

    function token1() external returns (address);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IWETH {
    function deposit() external payable;

    function transfer(address to, uint256 value) external returns (bool);

    function withdraw(uint256) external;
}

/** @notice Simple read stream */
library InputStream {
    /** @notice Creates stream from data
     * @param data data
     */
    function createStream(
        bytes memory data
    ) internal pure returns (uint256 stream) {
        assembly {
            stream := mload(0x40)
            mstore(0x40, add(stream, 64))
            mstore(stream, data)
            let length := mload(data)
            mstore(add(stream, 32), add(data, length))
        }
    }

    /** @notice Checks if stream is not empty
     * @param stream stream
     */
    function isNotEmpty(uint256 stream) internal pure returns (bool) {
        uint256 pos;
        uint256 finish;
        assembly {
            pos := mload(stream)
            finish := mload(add(stream, 32))
        }
        return pos < finish;
    }

    /** @notice Reads uint8 from the stream
     * @param stream stream
     */
    function readUint8(uint256 stream) internal pure returns (uint8 res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 1)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads uint16 from the stream
     * @param stream stream
     */
    function readUint16(uint256 stream) internal pure returns (uint16 res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 2)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads uint24 from the stream
     * @param stream stream
     */
    function readUint24(uint256 stream) internal pure returns (uint24 res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 3)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads uint32 from the stream
     * @param stream stream
     */
    function readUint32(uint256 stream) internal pure returns (uint32 res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 4)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads uint256 from the stream
     * @param stream stream
     */
    function readUint(uint256 stream) internal pure returns (uint256 res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 32)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads bytes32 from the stream
     * @param stream stream
     */
    function readBytes32(uint256 stream) internal pure returns (bytes32 res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 32)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads address from the stream
     * @param stream stream
     */
    function readAddress(uint256 stream) internal pure returns (address res) {
        assembly {
            let pos := mload(stream)
            pos := add(pos, 20)
            res := mload(pos)
            mstore(stream, pos)
        }
    }

    /** @notice Reads bytes from the stream
     * @param stream stream
     */
    function readBytes(
        uint256 stream
    ) internal pure returns (bytes memory res) {
        assembly {
            let pos := mload(stream)
            res := add(pos, 32)
            let length := mload(res)
            mstore(stream, add(res, length))
        }
    }
}

library Approve {
    /**
     * @dev ERC20 approve that correct works with token.approve which returns bool or nothing (USDT for example)
     * @param token The token targeted by the call.
     * @param spender token spender
     * @param amount token amount
     */
    function approveStable(
        IERC20 token,
        address spender,
        uint256 amount
    ) internal returns (bool) {
        (bool success, bytes memory data) = address(token).call(
            abi.encodeWithSelector(token.approve.selector, spender, amount)
        );
        return success && (data.length == 0 || abi.decode(data, (bool)));
    }

    /**
     * @dev ERC20 approve that correct works with token.approve which reverts if amount and
     *      current allowance are not zero simultaniously (USDT for example).
     *      In second case it tries to set allowance to 0, and then back to amount.
     * @param token The token targeted by the call.
     * @param spender token spender
     * @param amount token amount
     */
    function approveSafe(
        IERC20 token,
        address spender,
        uint256 amount
    ) internal returns (bool) {
        return
            approveStable(token, spender, amount) ||
            (approveStable(token, spender, 0) &&
                approveStable(token, spender, amount));
    }
}

struct Rebase {
    uint128 elastic;
    uint128 base;
}

struct StrategyData {
    uint64 strategyStartDate;
    uint64 targetPercentage;
    uint128 balance; // the balance of the strategy that BentoBox thinks is in there
}

/// @notice A rebasing library
library RebaseLibrary {
    /// @notice Calculates the base value in relationship to `elastic` and `total`.
    function toBase(
        Rebase memory total,
        uint256 elastic
    ) internal pure returns (uint256 base) {
        if (total.elastic == 0) {
            base = elastic;
        } else {
            base = (elastic * total.base) / total.elastic;
        }
    }

    /// @notice Calculates the elastic value in relationship to `base` and `total`.
    function toElastic(
        Rebase memory total,
        uint256 base
    ) internal pure returns (uint256 elastic) {
        if (total.base == 0) {
            elastic = base;
        } else {
            elastic = (base * total.elastic) / total.base;
        }
    }
}
