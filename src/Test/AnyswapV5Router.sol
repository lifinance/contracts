// SPDX-License-Identifier: GPL-3.0-or-later

// for testing only not for production
// solhint-disable

pragma solidity ^0.8.2;

interface ISushiswapV2Pair {
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);

    function name() external pure returns (string memory);

    function symbol() external pure returns (string memory);

    function decimals() external pure returns (uint8);

    function totalSupply() external view returns (uint256);

    function balanceOf(address owner) external view returns (uint256);

    function allowance(address owner, address spender) external view returns (uint256);

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
    event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to);
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

    function burn(address to) external returns (uint256 amount0, uint256 amount1);

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

// a library for performing overflow-safe math, courtesy of DappHub (https://github.com/dapphub/ds-math)

library SafeMathSushiswap {
    function add(uint256 x, uint256 y) internal pure returns (uint256 z) {
        require((z = x + y) >= x, "ds-math-add-overflow");
    }

    function sub(uint256 x, uint256 y) internal pure returns (uint256 z) {
        require((z = x - y) <= x, "ds-math-sub-underflow");
    }

    function mul(uint256 x, uint256 y) internal pure returns (uint256 z) {
        require(y == 0 || (z = x * y) / y == x, "ds-math-mul-overflow");
    }
}

library SushiswapV2Library {
    using SafeMathSushiswap for uint256;

    // returns sorted token addresses, used to handle return values from pairs sorted in this order
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, "SushiswapV2Library: IDENTICAL_ADDRESSES");
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "SushiswapV2Library: ZERO_ADDRESS");
    }

    // calculates the CREATE2 address for a pair without making any external calls
    function pairFor(
        address factory,
        address tokenA,
        address tokenB
    ) internal pure returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            hex"ff",
                            factory,
                            keccak256(abi.encodePacked(token0, token1)),
                            hex"e18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303" // init code hash
                        )
                    )
                )
            )
        );
    }

    // fetches and sorts the reserves for a pair
    function getReserves(
        address factory,
        address tokenA,
        address tokenB
    ) internal view returns (uint256 reserveA, uint256 reserveB) {
        (address token0, ) = sortTokens(tokenA, tokenB);
        (uint256 reserve0, uint256 reserve1, ) = ISushiswapV2Pair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    // given some amount of an asset and pair reserves, returns an equivalent amount of the other asset
    function quote(
        uint256 amountA,
        uint256 reserveA,
        uint256 reserveB
    ) internal pure returns (uint256 amountB) {
        require(amountA > 0, "SushiswapV2Library: INSUFFICIENT_AMOUNT");
        require(reserveA > 0 && reserveB > 0, "SushiswapV2Library: INSUFFICIENT_LIQUIDITY");
        amountB = amountA.mul(reserveB) / reserveA;
    }

    // given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, "SushiswapV2Library: INSUFFICIENT_INPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "SushiswapV2Library: INSUFFICIENT_LIQUIDITY");
        uint256 amountInWithFee = amountIn.mul(997);
        uint256 numerator = amountInWithFee.mul(reserveOut);
        uint256 denominator = reserveIn.mul(1000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }

    // given an output amount of an asset and pair reserves, returns a required input amount of the other asset
    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountIn) {
        require(amountOut > 0, "SushiswapV2Library: INSUFFICIENT_OUTPUT_AMOUNT");
        require(reserveIn > 0 && reserveOut > 0, "SushiswapV2Library: INSUFFICIENT_LIQUIDITY");
        uint256 numerator = reserveIn.mul(amountOut).mul(1000);
        uint256 denominator = reserveOut.sub(amountOut).mul(997);
        amountIn = (numerator / denominator).add(1);
    }

    // performs chained getAmountOut calculations on any number of pairs
    function getAmountsOut(
        address factory,
        uint256 amountIn,
        address[] memory path
    ) internal view returns (uint256[] memory amounts) {
        require(path.length >= 2, "SushiswapV2Library: INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i; i < path.length - 1; i++) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    // performs chained getAmountIn calculations on any number of pairs
    function getAmountsIn(
        address factory,
        uint256 amountOut,
        address[] memory path
    ) internal view returns (uint256[] memory amounts) {
        require(path.length >= 2, "SushiswapV2Library: INVALID_PATH");
        amounts = new uint256[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint256 i = path.length - 1; i > 0; i--) {
            (uint256 reserveIn, uint256 reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}

// helper methods for interacting with ERC20 tokens and sending NATIVE that do not consistently return true/false
library TransferHelper {
    function safeApprove(
        address token,
        address to,
        uint256 value
    ) internal {
        // bytes4(keccak256(bytes('approve(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferHelper: APPROVE_FAILED");
    }

    function safeTransfer(
        address token,
        address to,
        uint256 value
    ) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferHelper: TRANSFER_FAILED");
    }

    function safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 value
    ) internal {
        // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), "TransferHelper: TRANSFER_FROM_FAILED");
    }

    function safeTransferNative(address to, uint256 value) internal {
        (bool success, ) = to.call{ value: value }(new bytes(0));
        require(success, "TransferHelper: NATIVE_TRANSFER_FAILED");
    }
}

interface ISushiswapV2Factory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    function feeTo() external view returns (address);

    function feeToSetter() external view returns (address);

    function migrator() external view returns (address);

    function getPair(address tokenA, address tokenB) external view returns (address pair);

    function allPairs(uint256) external view returns (address pair);

    function allPairsLength() external view returns (uint256);

    function createPair(address tokenA, address tokenB) external returns (address pair);

    function setFeeTo(address) external;

    function setFeeToSetter(address) external;

    function setMigrator(address) external;
}

interface IwNATIVE {
    function deposit() external payable;

    function transfer(address to, uint256 value) external returns (bool);

    function withdraw(uint256) external;
}

interface AnyswapV1ERC20 {
    function mint(address to, uint256 amount) external returns (bool);

    function burn(address from, uint256 amount) external returns (bool);

    function changeVault(address newVault) external returns (bool);

    function depositVault(uint256 amount, address to) external returns (uint256);

    function withdrawVault(
        address from,
        uint256 amount,
        address to
    ) external returns (uint256);

    function underlying() external view returns (address);

    function deposit(uint256 amount, address to) external returns (uint256);

    function withdraw(uint256 amount, address to) external returns (uint256);
}

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    function totalSupply() external view returns (uint256);

    function balanceOf(address account) external view returns (uint256);

    function transfer(address recipient, uint256 amount) external returns (bool);

    function allowance(address owner, address spender) external view returns (uint256);

    function approve(address spender, uint256 amount) external returns (bool);

    function permit(
        address target,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external returns (bool);

    function transferWithPermit(
        address target,
        address to,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bool);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

library Address {
    function isContract(address account) internal view returns (bool) {
        bytes32 codehash;
        bytes32 accountHash = 0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            codehash := extcodehash(account)
        }
        return (codehash != 0x0 && codehash != accountHash);
    }
}

library SafeERC20 {
    using Address for address;

    function safeTransfer(
        IERC20 token,
        address to,
        uint256 value
    ) internal {
        callOptionalReturn(token, abi.encodeWithSelector(token.transfer.selector, to, value));
    }

    function safeTransferFrom(
        IERC20 token,
        address from,
        address to,
        uint256 value
    ) internal {
        callOptionalReturn(token, abi.encodeWithSelector(token.transferFrom.selector, from, to, value));
    }

    function safeApprove(
        IERC20 token,
        address spender,
        uint256 value
    ) internal {
        require(
            (value == 0) || (token.allowance(address(this), spender) == 0),
            "SafeERC20: approve from non-zero to non-zero allowance"
        );
        callOptionalReturn(token, abi.encodeWithSelector(token.approve.selector, spender, value));
    }

    function extractRevertReason(bytes memory revertData) internal pure returns (string memory reason) {
        uint256 l = revertData.length;
        if (l < 68) return "";
        uint256 t;
        assembly {
            revertData := add(revertData, 4)
            t := mload(revertData) // Save the content of the length slot
            mstore(revertData, sub(l, 4)) // Set proper length
        }
        reason = abi.decode(revertData, (string));
        assembly {
            mstore(revertData, t) // Restore the content of the length slot
        }
    }

    function callOptionalReturn(IERC20 token, bytes memory data) private {
        require(address(token).isContract(), "SafeERC20: call to non-contract");

        // solhint-disable-next-line avoid-low-level-calls
        (bool success, bytes memory returndata) = address(token).call(data);
        if (!success) {
            revert(extractRevertReason(returndata));
        }

        if (returndata.length > 0) {
            // Return data is optional
            // solhint-disable-next-line max-line-length
            require(abi.decode(returndata, (bool)), "SafeERC20: ERC20 operation did not succeed");
        }
    }
}

contract AnyswapV5Router {
    using SafeERC20 for IERC20;
    using SafeMathSushiswap for uint256;

    address public immutable factory;
    address public immutable wNATIVE;

    modifier ensure(uint256 deadline) {
        require(deadline >= block.timestamp, "AnyswapV3Router: EXPIRED");
        _;
    }

    constructor(
        address _factory,
        address _wNATIVE,
        address _mpc
    ) {
        _newMPC = _mpc;
        _newMPCEffectiveTime = block.timestamp;
        factory = _factory;
        wNATIVE = _wNATIVE;
    }

    receive() external payable {
        assert(msg.sender == wNATIVE); // only accept Native via fallback from the wNative contract
    }

    address private _oldMPC;
    address private _newMPC;
    uint256 private _newMPCEffectiveTime;

    event LogChangeMPC(address indexed oldMPC, address indexed newMPC, uint256 indexed effectiveTime, uint256 chainID);
    event LogChangeRouter(address indexed oldRouter, address indexed newRouter, uint256 chainID);
    event LogAnySwapIn(
        bytes32 indexed txhash,
        address indexed token,
        address indexed to,
        uint256 amount,
        uint256 fromChainID,
        uint256 toChainID
    );
    event LogAnySwapOut(
        address indexed token,
        address indexed from,
        address indexed to,
        uint256 amount,
        uint256 fromChainID,
        uint256 toChainID
    );
    event LogAnySwapTradeTokensForTokens(
        address[] path,
        address indexed from,
        address indexed to,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 fromChainID,
        uint256 toChainID
    );
    event LogAnySwapTradeTokensForNative(
        address[] path,
        address indexed from,
        address indexed to,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 fromChainID,
        uint256 toChainID
    );

    modifier onlyMPC() {
        require(msg.sender == mpc(), "AnyswapV3Router: FORBIDDEN");
        _;
    }

    function mpc() public view returns (address) {
        if (block.timestamp >= _newMPCEffectiveTime) {
            return _newMPC;
        }
        return _oldMPC;
    }

    function cID() public view returns (uint256 id) {
        assembly {
            id := chainid()
        }
    }

    function changeMPC(address newMPC) public onlyMPC returns (bool) {
        require(newMPC != address(0), "AnyswapV3Router: address(0x0)");
        _oldMPC = mpc();
        _newMPC = newMPC;
        _newMPCEffectiveTime = block.timestamp + 2 * 24 * 3600;
        emit LogChangeMPC(_oldMPC, _newMPC, _newMPCEffectiveTime, cID());
        return true;
    }

    function changeVault(address token, address newVault) public onlyMPC returns (bool) {
        require(newVault != address(0), "AnyswapV3Router: address(0x0)");
        return AnyswapV1ERC20(token).changeVault(newVault);
    }

    function _anySwapOut(
        address from,
        address token,
        address to,
        uint256 amount,
        uint256 toChainID
    ) internal {
        AnyswapV1ERC20(token).burn(from, amount);
        emit LogAnySwapOut(token, from, to, amount, cID(), toChainID);
    }

    // Swaps `amount` `token` from this chain to `toChainID` chain with recipient `to`
    function anySwapOut(
        address token,
        address to,
        uint256 amount,
        uint256 toChainID
    ) external {
        _anySwapOut(msg.sender, token, to, amount, toChainID);
    }

    // Swaps `amount` `token` from this chain to `toChainID` chain with recipient `to` by minting with `underlying`
    function anySwapOutUnderlying(
        address token,
        address to,
        uint256 amount,
        uint256 toChainID
    ) external {
        IERC20(AnyswapV1ERC20(token).underlying()).safeTransferFrom(msg.sender, token, amount);
        AnyswapV1ERC20(token).depositVault(amount, msg.sender);
        _anySwapOut(msg.sender, token, to, amount, toChainID);
    }

    function anySwapOutNative(
        address token,
        address to,
        uint256 toChainID
    ) external payable {
        require(AnyswapV1ERC20(token).underlying() == wNATIVE, "AnyswapV3Router: underlying is not wNATIVE");
        IwNATIVE(wNATIVE).deposit{ value: msg.value }();
        assert(IwNATIVE(wNATIVE).transfer(token, msg.value));
        AnyswapV1ERC20(token).depositVault(msg.value, msg.sender);
        _anySwapOut(msg.sender, token, to, msg.value, toChainID);
    }

    function anySwapOutUnderlyingWithPermit(
        address from,
        address token,
        address to,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 toChainID
    ) external {
        address _underlying = AnyswapV1ERC20(token).underlying();
        IERC20(_underlying).permit(from, address(this), amount, deadline, v, r, s);
        IERC20(_underlying).safeTransferFrom(from, token, amount);
        AnyswapV1ERC20(token).depositVault(amount, from);
        _anySwapOut(from, token, to, amount, toChainID);
    }

    function anySwapOutUnderlyingWithTransferPermit(
        address from,
        address token,
        address to,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 toChainID
    ) external {
        IERC20(AnyswapV1ERC20(token).underlying()).transferWithPermit(from, token, amount, deadline, v, r, s);
        AnyswapV1ERC20(token).depositVault(amount, from);
        _anySwapOut(from, token, to, amount, toChainID);
    }

    function anySwapOut(
        address[] calldata tokens,
        address[] calldata to,
        uint256[] calldata amounts,
        uint256[] calldata toChainIDs
    ) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            _anySwapOut(msg.sender, tokens[i], to[i], amounts[i], toChainIDs[i]);
        }
    }

    // swaps `amount` `token` in `fromChainID` to `to` on this chainID
    function _anySwapIn(
        bytes32 txs,
        address token,
        address to,
        uint256 amount,
        uint256 fromChainID
    ) internal {
        AnyswapV1ERC20(token).mint(to, amount);
        emit LogAnySwapIn(txs, token, to, amount, fromChainID, cID());
    }

    // swaps `amount` `token` in `fromChainID` to `to` on this chainID
    // triggered by `anySwapOut`
    function anySwapIn(
        bytes32 txs,
        address token,
        address to,
        uint256 amount,
        uint256 fromChainID
    ) external onlyMPC {
        _anySwapIn(txs, token, to, amount, fromChainID);
    }

    // swaps `amount` `token` in `fromChainID` to `to` on this chainID with `to` receiving `underlying`
    function anySwapInUnderlying(
        bytes32 txs,
        address token,
        address to,
        uint256 amount,
        uint256 fromChainID
    ) external onlyMPC {
        _anySwapIn(txs, token, to, amount, fromChainID);
        AnyswapV1ERC20(token).withdrawVault(to, amount, to);
    }

    // swaps `amount` `token` in `fromChainID` to `to` on this chainID with `to` receiving `underlying` if possible
    function anySwapInAuto(
        bytes32 txs,
        address token,
        address to,
        uint256 amount,
        uint256 fromChainID
    ) external onlyMPC {
        _anySwapIn(txs, token, to, amount, fromChainID);
        AnyswapV1ERC20 _anyToken = AnyswapV1ERC20(token);
        address _underlying = _anyToken.underlying();
        if (_underlying != address(0) && IERC20(_underlying).balanceOf(token) >= amount) {
            if (_underlying == wNATIVE) {
                _anyToken.withdrawVault(to, amount, address(this));
                IwNATIVE(wNATIVE).withdraw(amount);
                TransferHelper.safeTransferNative(to, amount);
            } else {
                _anyToken.withdrawVault(to, amount, to);
            }
        }
    }

    function depositNative(address token, address to) external payable returns (uint256) {
        require(AnyswapV1ERC20(token).underlying() == wNATIVE, "AnyswapV3Router: underlying is not wNATIVE");
        IwNATIVE(wNATIVE).deposit{ value: msg.value }();
        assert(IwNATIVE(wNATIVE).transfer(token, msg.value));
        AnyswapV1ERC20(token).depositVault(msg.value, to);
        return msg.value;
    }

    function withdrawNative(
        address token,
        uint256 amount,
        address to
    ) external returns (uint256) {
        require(AnyswapV1ERC20(token).underlying() == wNATIVE, "AnyswapV3Router: underlying is not wNATIVE");
        AnyswapV1ERC20(token).withdrawVault(msg.sender, amount, address(this));
        IwNATIVE(wNATIVE).withdraw(amount);
        TransferHelper.safeTransferNative(to, amount);
        return amount;
    }

    // extracts mpc fee from bridge fees
    function anySwapFeeTo(address token, uint256 amount) external onlyMPC {
        address _mpc = mpc();
        AnyswapV1ERC20(token).mint(_mpc, amount);
        AnyswapV1ERC20(token).withdrawVault(_mpc, amount, _mpc);
    }

    function anySwapIn(
        bytes32[] calldata txs,
        address[] calldata tokens,
        address[] calldata to,
        uint256[] calldata amounts,
        uint256[] calldata fromChainIDs
    ) external onlyMPC {
        for (uint256 i = 0; i < tokens.length; i++) {
            _anySwapIn(txs[i], tokens[i], to[i], amounts[i], fromChainIDs[i]);
        }
    }

    // **** SWAP ****
    // requires the initial amount to have already been sent to the first pair
    function _swap(
        uint256[] memory amounts,
        address[] memory path,
        address _to
    ) internal virtual {
        for (uint256 i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0, ) = SushiswapV2Library.sortTokens(input, output);
            uint256 amountOut = amounts[i + 1];
            (uint256 amount0Out, uint256 amount1Out) = input == token0
                ? (uint256(0), amountOut)
                : (amountOut, uint256(0));
            address to = i < path.length - 2 ? SushiswapV2Library.pairFor(factory, output, path[i + 2]) : _to;
            ISushiswapV2Pair(SushiswapV2Library.pairFor(factory, input, output)).swap(
                amount0Out,
                amount1Out,
                to,
                new bytes(0)
            );
        }
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        AnyswapV1ERC20(path[0]).burn(msg.sender, amountIn);
        emit LogAnySwapTradeTokensForTokens(path, msg.sender, to, amountIn, amountOutMin, cID(), toChainID);
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForTokensUnderlying(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        IERC20(AnyswapV1ERC20(path[0]).underlying()).safeTransferFrom(msg.sender, path[0], amountIn);
        AnyswapV1ERC20(path[0]).depositVault(amountIn, msg.sender);
        AnyswapV1ERC20(path[0]).burn(msg.sender, amountIn);
        emit LogAnySwapTradeTokensForTokens(path, msg.sender, to, amountIn, amountOutMin, cID(), toChainID);
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForTokensUnderlyingWithPermit(
        address from,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        address _underlying = AnyswapV1ERC20(path[0]).underlying();
        IERC20(_underlying).permit(from, address(this), amountIn, deadline, v, r, s);
        IERC20(_underlying).safeTransferFrom(from, path[0], amountIn);
        AnyswapV1ERC20(path[0]).depositVault(amountIn, from);
        AnyswapV1ERC20(path[0]).burn(from, amountIn);
        {
            address[] memory _path = path;
            address _from = from;
            address _to = to;
            uint256 _amountIn = amountIn;
            uint256 _amountOutMin = amountOutMin;
            uint256 _cID = cID();
            uint256 _toChainID = toChainID;
            emit LogAnySwapTradeTokensForTokens(_path, _from, _to, _amountIn, _amountOutMin, _cID, _toChainID);
        }
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForTokensUnderlyingWithTransferPermit(
        address from,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        IERC20(AnyswapV1ERC20(path[0]).underlying()).transferWithPermit(from, path[0], amountIn, deadline, v, r, s);
        AnyswapV1ERC20(path[0]).depositVault(amountIn, from);
        AnyswapV1ERC20(path[0]).burn(from, amountIn);
        emit LogAnySwapTradeTokensForTokens(path, from, to, amountIn, amountOutMin, cID(), toChainID);
    }

    // Swaps `amounts[path.length-1]` `path[path.length-1]` to `to` on this chain
    // Triggered by `anySwapOutExactTokensForTokens`
    function anySwapInExactTokensForTokens(
        bytes32 txs,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 fromChainID
    ) external virtual onlyMPC ensure(deadline) returns (uint256[] memory amounts) {
        amounts = SushiswapV2Library.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "SushiswapV2Router: INSUFFICIENT_OUTPUT_AMOUNT");
        _anySwapIn(txs, path[0], SushiswapV2Library.pairFor(factory, path[0], path[1]), amounts[0], fromChainID);
        _swap(amounts, path, to);
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForNative(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        AnyswapV1ERC20(path[0]).burn(msg.sender, amountIn);
        emit LogAnySwapTradeTokensForNative(path, msg.sender, to, amountIn, amountOutMin, cID(), toChainID);
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForNativeUnderlying(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        IERC20(AnyswapV1ERC20(path[0]).underlying()).safeTransferFrom(msg.sender, path[0], amountIn);
        AnyswapV1ERC20(path[0]).depositVault(amountIn, msg.sender);
        AnyswapV1ERC20(path[0]).burn(msg.sender, amountIn);
        emit LogAnySwapTradeTokensForNative(path, msg.sender, to, amountIn, amountOutMin, cID(), toChainID);
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForNativeUnderlyingWithPermit(
        address from,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        address _underlying = AnyswapV1ERC20(path[0]).underlying();
        IERC20(_underlying).permit(from, address(this), amountIn, deadline, v, r, s);
        IERC20(_underlying).safeTransferFrom(from, path[0], amountIn);
        AnyswapV1ERC20(path[0]).depositVault(amountIn, from);
        AnyswapV1ERC20(path[0]).burn(from, amountIn);
        {
            address[] memory _path = path;
            address _from = from;
            address _to = to;
            uint256 _amountIn = amountIn;
            uint256 _amountOutMin = amountOutMin;
            uint256 _cID = cID();
            uint256 _toChainID = toChainID;
            emit LogAnySwapTradeTokensForNative(_path, _from, _to, _amountIn, _amountOutMin, _cID, _toChainID);
        }
    }

    // sets up a cross-chain trade from this chain to `toChainID` for `path` trades to `to`
    function anySwapOutExactTokensForNativeUnderlyingWithTransferPermit(
        address from,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        uint256 toChainID
    ) external virtual ensure(deadline) {
        IERC20(AnyswapV1ERC20(path[0]).underlying()).transferWithPermit(from, path[0], amountIn, deadline, v, r, s);
        AnyswapV1ERC20(path[0]).depositVault(amountIn, from);
        AnyswapV1ERC20(path[0]).burn(from, amountIn);
        emit LogAnySwapTradeTokensForNative(path, from, to, amountIn, amountOutMin, cID(), toChainID);
    }

    // Swaps `amounts[path.length-1]` `path[path.length-1]` to `to` on this chain
    // Triggered by `anySwapOutExactTokensForNative`
    function anySwapInExactTokensForNative(
        bytes32 txs,
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline,
        uint256 fromChainID
    ) external virtual onlyMPC ensure(deadline) returns (uint256[] memory amounts) {
        require(path[path.length - 1] == wNATIVE, "AnyswapV3Router: INVALID_PATH");
        amounts = SushiswapV2Library.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, "AnyswapV3Router: INSUFFICIENT_OUTPUT_AMOUNT");
        _anySwapIn(txs, path[0], SushiswapV2Library.pairFor(factory, path[0], path[1]), amounts[0], fromChainID);
        _swap(amounts, path, address(this));
        IwNATIVE(wNATIVE).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferNative(to, amounts[amounts.length - 1]);
    }

    // **** LIBRARY FUNCTIONS ****
    function quote(
        uint256 amountA,
        uint256 reserveA,
        uint256 reserveB
    ) public pure virtual returns (uint256 amountB) {
        return SushiswapV2Library.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure virtual returns (uint256 amountOut) {
        return SushiswapV2Library.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) public pure virtual returns (uint256 amountIn) {
        return SushiswapV2Library.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint256 amountIn, address[] memory path)
        public
        view
        virtual
        returns (uint256[] memory amounts)
    {
        return SushiswapV2Library.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint256 amountOut, address[] memory path)
        public
        view
        virtual
        returns (uint256[] memory amounts)
    {
        return SushiswapV2Library.getAmountsIn(factory, amountOut, path);
    }
}
