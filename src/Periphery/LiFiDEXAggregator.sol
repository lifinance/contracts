// SPDX-License-Identifier: UNLICENSED

pragma solidity ^0.8.17;

import { SafeERC20, IERC20, IERC20Permit } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

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

/// @title LiFi DEX Aggregator
/// @author Ilya Lyalin (contract copied from: https://github.com/sushiswap/sushiswap/blob/c8c80dec821003eb72eb77c7e0446ddde8ca9e1e/protocols/route-processor/contracts/RouteProcessor4.sol)
/// @notice Processes calldata to swap using various DEXs
/// @custom:version 1.0.0
contract LiFiDEXAggregator is Ownable {
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

    IBentoBoxMinimal public immutable bentoBox;
    mapping(address => bool) public priviledgedUsers;
    address private lastCalledPool;

    uint8 private unlocked = NOT_LOCKED;
    uint8 private paused = NOT_PAUSED;
    modifier lock() {
        require(unlocked == NOT_LOCKED, "RouteProcessor is locked");
        require(paused == NOT_PAUSED, "RouteProcessor is paused");
        unlocked = LOCKED;
        _;
        unlocked = NOT_LOCKED;
    }

    modifier onlyOwnerOrPriviledgedUser() {
        require(
            msg.sender == owner() || priviledgedUsers[msg.sender],
            "RP: caller is not the owner or a privileged user"
        );
        _;
    }

    constructor(address _bentoBox, address[] memory priviledgedUserList) {
        bentoBox = IBentoBoxMinimal(_bentoBox);
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
        (bool success, bytes memory returnBytes) = transferValueTo.call{
            value: amountValueTransfer
        }("");
        if (!success) {
            assembly {
                revert(add(32, returnBytes), mload(returnBytes))
            }
        }
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
                else revert("RouteProcessor: Unknown command code");
                ++step;
            }
        }

        uint256 balanceInFinal = tokenIn == NATIVE_ADDRESS
            ? 0
            : IERC20(tokenIn).balanceOf(msg.sender);
        require(
            balanceInFinal + amountIn >= balanceInInitial,
            "RouteProcessor: Minimal input balance violation"
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
        uint256 amountTotal = bentoBox.balanceOf(token, address(this));
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
        if (poolType == 0) swapUniV2(stream, from, tokenIn, amountIn);
        else if (poolType == 1) swapUniV3(stream, from, tokenIn, amountIn);
        else if (poolType == 2) wrapNative(stream, from, tokenIn, amountIn);
        else if (poolType == 3) bentoBridge(stream, from, tokenIn, amountIn);
        else if (poolType == 4) swapTrident(stream, from, tokenIn, amountIn);
        else if (poolType == 5) swapCurve(stream, from, tokenIn, amountIn);
        else revert("RouteProcessor: Unknown pool type");
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
            (bool success, ) = payable(to).call{ value: amountIn }("");
            require(
                success,
                "RouteProcessor.wrapNative: Native token transfer failed"
            );
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
            // deposit to arbitrary recipient is possible only from address(bentoBox)
            if (from == address(this))
                IERC20(tokenIn).safeTransfer(address(bentoBox), amountIn);
            else if (from == msg.sender)
                IERC20(tokenIn).safeTransferFrom(
                    msg.sender,
                    address(bentoBox),
                    amountIn
                );
            else {
                // tokens already are at address(bentoBox)
                amountIn =
                    IERC20(tokenIn).balanceOf(address(bentoBox)) +
                    bentoBox.strategyData(tokenIn).balance -
                    bentoBox.totals(tokenIn).elastic;
            }
            bentoBox.deposit(tokenIn, address(bentoBox), to, amountIn, 0);
        } else {
            // Bento to outside
            if (from != INTERNAL_INPUT_SOURCE) {
                bentoBox.transfer(tokenIn, from, address(this), amountIn);
            } else amountIn = bentoBox.balanceOf(tokenIn, address(this));
            bentoBox.withdraw(tokenIn, address(this), to, 0, amountIn);
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
        require(r0 > 0 && r1 > 0, "Wrong pool reserves");
        (uint256 reserveIn, uint256 reserveOut) = direction == 1
            ? (r0, r1)
            : (r1, r0);
        amountIn = IERC20(tokenIn).balanceOf(pool) - reserveIn; // tokens already were transferred

        uint256 amountInWithFee = amountIn * (1_000_000 - fee);
        uint256 amountOut = (amountInWithFee * reserveOut) /
            (reserveIn * 1_000_000 + amountInWithFee);
        (uint256 amount0Out, uint256 amount1Out) = direction == 1
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
            bentoBox.transfer(tokenIn, from, pool, amountIn);
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
        bool zeroForOne = stream.readUint8() > 0;
        address recipient = stream.readAddress();

        if (from == msg.sender)
            IERC20(tokenIn).safeTransferFrom(
                msg.sender,
                address(this),
                uint256(amountIn)
            );

        lastCalledPool = pool;
        IUniswapV3Pool(pool).swap(
            recipient,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn)
        );
        require(
            lastCalledPool == IMPOSSIBLE_POOL_ADDRESS,
            "RouteProcessor.swapUniV3: unexpected"
        ); // Just to be sure
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
        require(
            msg.sender == lastCalledPool,
            "RouteProcessor.uniswapV3SwapCallback: call from unknown source"
        );
        int256 amount = amount0Delta > 0 ? amount0Delta : amount1Delta;
        require(
            amount > 0,
            "RouteProcessor.uniswapV3SwapCallback: not positive amount"
        );

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
                (bool success, ) = payable(to).call{ value: amountOut }("");
                require(
                    success,
                    "RouteProcessor.swapCurve: Native token transfer failed"
                );
            } else {
                IERC20(tokenOut).safeTransfer(to, amountOut);
            }
        }
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
        uint256 min_dy
    ) external payable returns (uint256);
}

interface ICurveLegacy {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
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
    event Approval(address indexed owner, address indexed spender, uint value);
    event Transfer(address indexed from, address indexed to, uint value);

    function name() external pure returns (string memory);

    function symbol() external pure returns (string memory);

    function decimals() external pure returns (uint8);

    function totalSupply() external view returns (uint);

    function balanceOf(address owner) external view returns (uint);

    function allowance(
        address owner,
        address spender
    ) external view returns (uint);

    function approve(address spender, uint value) external returns (bool);

    function transfer(address to, uint value) external returns (bool);

    function transferFrom(
        address from,
        address to,
        uint value
    ) external returns (bool);

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function PERMIT_TYPEHASH() external pure returns (bytes32);

    function nonces(address owner) external view returns (uint);

    function permit(
        address owner,
        address spender,
        uint value,
        uint deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    event Mint(address indexed sender, uint amount0, uint amount1);
    event Burn(
        address indexed sender,
        uint amount0,
        uint amount1,
        address indexed to
    );
    event Swap(
        address indexed sender,
        uint amount0In,
        uint amount1In,
        uint amount0Out,
        uint amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);

    function MINIMUM_LIQUIDITY() external pure returns (uint);

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

    function price0CumulativeLast() external view returns (uint);

    function price1CumulativeLast() external view returns (uint);

    function kLast() external view returns (uint);

    function mint(address to) external returns (uint liquidity);

    function burn(address to) external returns (uint amount0, uint amount1);

    function swap(
        uint amount0Out,
        uint amount1Out,
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
