// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../../framework/MessageApp.sol";
import "../../../interfaces/IWETH.sol";
import "../../../interfaces/IUniswapV2.sol";

/**
 * @title Demo application contract that facilitates swapping on a chain, transferring to another chain,
 * and swapping another time on the destination chain before sending the result tokens to a user
 */
contract TransferSwap is MessageApp {
    using SafeERC20 for IERC20;

    modifier onlyEOA() {
        require(msg.sender == tx.origin, "Not EOA");
        _;
    }

    struct SwapInfo {
        // if this array has only one element, it means no need to swap
        address[] path;
        // the following fields are only needed if path.length > 1
        address dex; // the DEX to use for the swap
        uint256 deadline; // deadline for the swap
        uint256 minRecvAmt; // minimum receive amount for the swap
    }

    struct SwapRequest {
        SwapInfo swap;
        // the receiving party (the user) of the final output token
        address receiver;
        // this field is best to be per-user per-transaction unique so that
        // a nonce that is specified by the calling party (the user),
        uint64 nonce;
        // indicates whether the output token coming out of the swap on destination
        // chain should be unwrapped before sending to the user
        bool nativeOut;
    }

    enum SwapStatus {
        Null,
        Succeeded,
        Failed,
        Fallback
    }

    // emitted when requested dstChainId == srcChainId, no bridging
    event DirectSwap(
        bytes32 id,
        uint64 srcChainId,
        uint256 amountIn,
        address tokenIn,
        uint256 amountOut,
        address tokenOut
    );
    event SwapRequestSent(bytes32 id, uint64 dstChainId, uint256 srcAmount, address srcToken, address dstToken);
    event SwapRequestDone(bytes32 id, uint256 dstAmount, SwapStatus status);

    mapping(address => uint256) public minSwapAmounts;
    mapping(address => bool) supportedDex;

    // erc20 wrap of gas token of this chain, eg. WETH
    address public nativeWrap;

    constructor(
        address _messageBus,
        address _supportedDex,
        address _nativeWrap
    ) MessageApp(_messageBus) {
        supportedDex[_supportedDex] = true;
        nativeWrap = _nativeWrap;
    }

    function transferWithSwapNative(
        address _receiver,
        uint256 _amountIn,
        uint64 _dstChainId,
        SwapInfo calldata _srcSwap,
        SwapInfo calldata _dstSwap,
        uint32 _maxBridgeSlippage,
        uint64 _nonce,
        bool _nativeOut
    ) external payable onlyEOA {
        require(msg.value >= _amountIn, "Amount insufficient");
        require(_srcSwap.path[0] == nativeWrap, "token mismatch");
        IWETH(nativeWrap).deposit{value: _amountIn}();
        _transferWithSwap(
            _receiver,
            _amountIn,
            _dstChainId,
            _srcSwap,
            _dstSwap,
            _maxBridgeSlippage,
            _nonce,
            _nativeOut,
            msg.value - _amountIn
        );
    }

    function transferWithSwap(
        address _receiver,
        uint256 _amountIn,
        uint64 _dstChainId,
        SwapInfo calldata _srcSwap,
        SwapInfo calldata _dstSwap,
        uint32 _maxBridgeSlippage,
        uint64 _nonce
    ) external payable onlyEOA {
        IERC20(_srcSwap.path[0]).safeTransferFrom(msg.sender, address(this), _amountIn);
        _transferWithSwap(
            _receiver,
            _amountIn,
            _dstChainId,
            _srcSwap,
            _dstSwap,
            _maxBridgeSlippage,
            _nonce,
            false,
            msg.value
        );
    }

    /**
     * @notice Sends a cross-chain transfer via the liquidity pool-based bridge and sends a message specifying a wanted swap action on the
               destination chain via the message bus
     * @param _receiver the app contract that implements the MessageReceiver abstract contract
     *        NOTE not to be confused with the receiver field in SwapInfo which is an EOA address of a user
     * @param _amountIn the input amount that the user wants to swap and/or bridge
     * @param _dstChainId destination chain ID
     * @param _srcSwap a struct containing swap related requirements
     * @param _dstSwap a struct containing swap related requirements
     * @param _maxBridgeSlippage the max acceptable slippage at bridge, given as percentage in point (pip). Eg. 5000 means 0.5%.
     *        Must be greater than minimalMaxSlippage. Receiver is guaranteed to receive at least (100% - max slippage percentage) * amount or the
     *        transfer can be refunded.
     * @param _fee the fee to pay to MessageBus.
     */
    function _transferWithSwap(
        address _receiver,
        uint256 _amountIn,
        uint64 _dstChainId,
        SwapInfo memory _srcSwap,
        SwapInfo memory _dstSwap,
        uint32 _maxBridgeSlippage,
        uint64 _nonce,
        bool _nativeOut,
        uint256 _fee
    ) private {
        require(_srcSwap.path.length > 0, "empty src swap path");
        address srcTokenOut = _srcSwap.path[_srcSwap.path.length - 1];

        require(_amountIn > minSwapAmounts[_srcSwap.path[0]], "amount must be greater than min swap amount");
        uint64 chainId = uint64(block.chainid);
        require(_srcSwap.path.length > 1 || _dstChainId != chainId, "noop is not allowed"); // revert early to save gas

        uint256 srcAmtOut = _amountIn;

        // swap source token for intermediate token on the source DEX
        if (_srcSwap.path.length > 1) {
            bool ok = true;
            (ok, srcAmtOut) = _trySwap(_srcSwap, _amountIn);
            if (!ok) revert("src swap failed");
        }

        if (_dstChainId == chainId) {
            _directSend(_receiver, _amountIn, chainId, _srcSwap, _nonce, srcTokenOut, srcAmtOut);
        } else {
            _crossChainTransferWithSwap(
                _receiver,
                _amountIn,
                chainId,
                _dstChainId,
                _srcSwap,
                _dstSwap,
                _maxBridgeSlippage,
                _nonce,
                _nativeOut,
                _fee,
                srcTokenOut,
                srcAmtOut
            );
        }
    }

    function _directSend(
        address _receiver,
        uint256 _amountIn,
        uint64 _chainId,
        SwapInfo memory _srcSwap,
        uint64 _nonce,
        address srcTokenOut,
        uint256 srcAmtOut
    ) private {
        // no need to bridge, directly send the tokens to user
        IERC20(srcTokenOut).safeTransfer(_receiver, srcAmtOut);
        // use uint64 for chainid to be consistent with other components in the system
        bytes32 id = keccak256(abi.encode(msg.sender, _chainId, _receiver, _nonce, _srcSwap));
        emit DirectSwap(id, _chainId, _amountIn, _srcSwap.path[0], srcAmtOut, srcTokenOut);
    }

    function _crossChainTransferWithSwap(
        address _receiver,
        uint256 _amountIn,
        uint64 _chainId,
        uint64 _dstChainId,
        SwapInfo memory _srcSwap,
        SwapInfo memory _dstSwap,
        uint32 _maxBridgeSlippage,
        uint64 _nonce,
        bool _nativeOut,
        uint256 _fee,
        address srcTokenOut,
        uint256 srcAmtOut
    ) private {
        require(_dstSwap.path.length > 0, "empty dst swap path");
        bytes memory message = abi.encode(
            SwapRequest({swap: _dstSwap, receiver: msg.sender, nonce: _nonce, nativeOut: _nativeOut})
        );
        bytes32 id = _computeSwapRequestId(msg.sender, _chainId, _dstChainId, message);
        // bridge the intermediate token to destination chain along with the message
        // NOTE In production, it's better use a per-user per-transaction nonce so that it's less likely transferId collision
        // would happen at Bridge contract. Currently this nonce is a timestamp supplied by frontend
        sendMessageWithTransfer(
            _receiver,
            srcTokenOut,
            srcAmtOut,
            _dstChainId,
            _nonce,
            _maxBridgeSlippage,
            message,
            MsgDataTypes.BridgeSendType.Liquidity,
            _fee
        );
        emit SwapRequestSent(id, _dstChainId, _amountIn, _srcSwap.path[0], _dstSwap.path[_dstSwap.path.length - 1]);
    }

    /**
     * @notice called by MessageBus when the tokens are checked to be arrived at this contract's address.
               sends the amount received to the receiver. swaps beforehand if swap behavior is defined in message
     * NOTE: if the swap fails, it sends the tokens received directly to the receiver as fallback behavior
     * @param _token the address of the token sent through the bridge
     * @param _amount the amount of tokens received at this contract through the cross-chain bridge
     * @param _srcChainId source chain ID
     * @param _message SwapRequest message that defines the swap behavior on this destination chain
     */
    function executeMessageWithTransfer(
        address, // _sender
        address _token,
        uint256 _amount,
        uint64 _srcChainId,
        bytes memory _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        SwapRequest memory m = abi.decode((_message), (SwapRequest));
        require(_token == m.swap.path[0], "bridged token must be the same as the first token in destination swap path");
        bytes32 id = _computeSwapRequestId(m.receiver, _srcChainId, uint64(block.chainid), _message);
        uint256 dstAmount;
        SwapStatus status = SwapStatus.Succeeded;

        if (m.swap.path.length > 1) {
            bool ok = true;
            (ok, dstAmount) = _trySwap(m.swap, _amount);
            if (ok) {
                _sendToken(m.swap.path[m.swap.path.length - 1], dstAmount, m.receiver, m.nativeOut);
                status = SwapStatus.Succeeded;
            } else {
                // handle swap failure, send the received token directly to receiver
                _sendToken(_token, _amount, m.receiver, false);
                dstAmount = _amount;
                status = SwapStatus.Fallback;
            }
        } else {
            // no need to swap, directly send the bridged token to user
            _sendToken(m.swap.path[0], _amount, m.receiver, m.nativeOut);
            dstAmount = _amount;
            status = SwapStatus.Succeeded;
        }
        emit SwapRequestDone(id, dstAmount, status);
        // always return success since swap failure is already handled in-place
        return ExecutionStatus.Success;
    }

    /**
     * @notice called by MessageBus when the executeMessageWithTransfer call fails. does nothing but emitting a "fail" event
     * @param _srcChainId source chain ID
     * @param _message SwapRequest message that defines the swap behavior on this destination chain
     */
    function executeMessageWithTransferFallback(
        address, // _sender
        address, // _token
        uint256, // _amount
        uint64 _srcChainId,
        bytes memory _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        SwapRequest memory m = abi.decode((_message), (SwapRequest));
        bytes32 id = _computeSwapRequestId(m.receiver, _srcChainId, uint64(block.chainid), _message);
        emit SwapRequestDone(id, 0, SwapStatus.Failed);
        // always return fail to mark this transfer as failed since if this function is called then there nothing more
        // we can do in this app as the swap failures are already handled in executeMessageWithTransfer
        return ExecutionStatus.Fail;
    }

    function _trySwap(SwapInfo memory _swap, uint256 _amount) private returns (bool ok, uint256 amountOut) {
        uint256 zero;
        if (!supportedDex[_swap.dex]) {
            return (false, zero);
        }
        IERC20(_swap.path[0]).safeIncreaseAllowance(_swap.dex, _amount);
        try
            IUniswapV2(_swap.dex).swapExactTokensForTokens(
                _amount,
                _swap.minRecvAmt,
                _swap.path,
                address(this),
                _swap.deadline
            )
        returns (uint256[] memory amounts) {
            return (true, amounts[amounts.length - 1]);
        } catch {
            return (false, zero);
        }
    }

    function _sendToken(
        address _token,
        uint256 _amount,
        address _receiver,
        bool _nativeOut
    ) private {
        if (_nativeOut) {
            require(_token == nativeWrap, "token mismatch");
            IWETH(nativeWrap).withdraw(_amount);
            (bool sent, ) = _receiver.call{value: _amount, gas: 50000}("");
            require(sent, "failed to send native");
        } else {
            IERC20(_token).safeTransfer(_receiver, _amount);
        }
    }

    function _computeSwapRequestId(
        address _sender,
        uint64 _srcChainId,
        uint64 _dstChainId,
        bytes memory _message
    ) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(_sender, _srcChainId, _dstChainId, _message));
    }

    function setMinSwapAmount(address _token, uint256 _minSwapAmount) external onlyOwner {
        minSwapAmounts[_token] = _minSwapAmount;
    }

    function setSupportedDex(address _dex, bool _enabled) external onlyOwner {
        supportedDex[_dex] = _enabled;
    }

    function setNativeWrap(address _nativeWrap) external onlyOwner {
        nativeWrap = _nativeWrap;
    }

    // This is needed to receive ETH when calling `IWETH.withdraw`
    receive() external payable {}
}
