// SPDX-License-Identifier: GPL-3.0-only

pragma solidity >=0.8.9;

import "../../framework/MessageApp.sol";

interface ISwapToken {
    // function sellBase(address to) external returns (uint256);
    // uniswap v2
    function swapExactTokensForTokens(
        uint256,
        uint256,
        address[] calldata,
        address,
        uint256
    ) external returns (uint256[] memory);
}

contract CrossChainSwap is MessageApp {
    using SafeERC20 for IERC20;

    address public dex; // needed on swap chain

    struct SwapInfo {
        address wantToken; // token user want to receive on dest chain
        address user;
        bool sendBack; // if true, send wantToken back to start chain
        uint32 cbrMaxSlippage; // _maxSlippage for cbridge send
    }

    constructor(address _messageBus, address dex_) MessageApp(_messageBus) {
        dex = dex_;
    }

    // ========== on start chain ==========

    uint64 nonce; // required by IBridge.send

    // this func could be called by a router contract
    function startCrossChainSwap(
        address _receiver,
        address _token,
        uint256 _amount,
        uint64 _dstChainId,
        SwapInfo calldata swapInfo // wantToken on destChain and actual user address as receiver when send back
    ) external payable {
        nonce += 1;
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amount);
        bytes memory message = abi.encode(swapInfo);
        sendMessageWithTransfer(
            _receiver,
            _token,
            _amount,
            _dstChainId,
            nonce,
            swapInfo.cbrMaxSlippage,
            message,
            MsgDataTypes.BridgeSendType.Liquidity,
            msg.value
        );
    }

    // ========== on swap chain ==========
    // do dex, send received asset to src chain via bridge
    function executeMessageWithTransfer(
        address, // _sender
        address _token,
        uint256 _amount,
        uint64 _srcChainId,
        bytes memory _message,
        address // executor
    ) external payable override onlyMessageBus returns (ExecutionStatus) {
        SwapInfo memory swapInfo = abi.decode((_message), (SwapInfo));
        IERC20(_token).approve(dex, _amount);
        address[] memory path = new address[](2);
        path[0] = _token;
        path[1] = swapInfo.wantToken;
        if (swapInfo.sendBack) {
            nonce += 1;
            uint256[] memory swapReturn = ISwapToken(dex).swapExactTokensForTokens(
                _amount,
                0,
                path,
                address(this),
                type(uint256).max
            );
            // send received token back to start chain. swapReturn[1] is amount of wantToken
            sendTokenTransfer(
                swapInfo.user,
                swapInfo.wantToken,
                swapReturn[1],
                _srcChainId,
                nonce,
                swapInfo.cbrMaxSlippage,
                MsgDataTypes.BridgeSendType.Liquidity
            );
        } else {
            // swap to wantToken and send to user
            ISwapToken(dex).swapExactTokensForTokens(_amount, 0, path, swapInfo.user, type(uint256).max);
        }
        // bytes memory notice; // send back to src chain to handleMessage
        // sendMessage(_sender, _srcChainId, notice);
        return ExecutionStatus.Success;
    }
}
