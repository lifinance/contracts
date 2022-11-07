// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap, InsufficientBalance } from "../Libraries/LibSwap.sol";
import { InvalidCaller, InsufficientBalance } from "../Errors/GenericErrors.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { IMessageReceiverApp } from"celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";

/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
contract Receiver is ILiFi, ReentrancyGuard, TransferrableOwnership {
    using SafeERC20 for IERC20;

    /// Storage ///
    address public sgRouter;
    address public cBridgeMessageBusAddress;
    IExecutor public executor;

    /// Errors ///
    error InvalidStargateRouter();

    /// Events ///
    event StargateRouterSet(address indexed router);

    /// Modifiers ///
    modifier onlyCBridgeMessageBus {
        if (msg.sender != cBridgeMessageBusAddress) revert InvalidCaller();
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _sgRouter,
        address _executor
    ) TransferrableOwnership(_owner) {
        owner = _owner;
        sgRouter = _sgRouter;
        executor = IExecutor(_executor);
        emit StargateRouterSet(_sgRouter);
    }

    /// External Methods ///

    /// @notice set Stargate Router
    /// @param _router the Stargate router address
    function setStargateRouter(address _router) external onlyOwner {
        sgRouter = _router;
        emit StargateRouterSet(_router);
    }

    /// @notice set CBridge MessageBus address
    /// @param _messageBusAddress the MessageBus address
    function setCBridgeMessageBus(address _messageBusAddress) external onlyOwner {
        cBridgeMessageBusAddress = _messageBusAddress;
        emit StargateRouterSet(_messageBusAddress);
    }

    /// @notice Completes a cross-chain transaction on the receiving chain.
    /// @dev This function is called from Stargate Router.
    /// @param * (unused) The remote chainId sending the tokens
    /// @param * (unused) The remote Bridge address
    /// @param * (unused) Nonce
    /// @param * (unused) The token contract on the local chain
    /// @param _amountLD The amount of local _token contract tokens
    /// @param _payload The data to execute
    function sgReceive(
        uint16, // _srcChainId unused
        bytes memory, // _srcAddress unused
        uint256, // _nonce unused
        address _token,
        uint256 _amountLD,
        bytes memory _payload
    ) external nonReentrant {
        (bytes32 transactionId, LibSwap.SwapData[] memory swapData, , address receiver) = abi.decode(
            _payload,
            (bytes32, LibSwap.SwapData[], address, address)
        );

        _swapAndCompleteBridgeTokens(transactionId, swapData, _token, payable(receiver), _amountLD);
    }


    function testReceive(bytes memory _payload) external {

    }

    /**
     * @notice called by CBridge MessageBus when the tokens are checked to be arrived at this contract's address.
               sends the amount received to the receiver. swaps beforehand if swap behavior is defined in message
     * NOTE: if the swap fails, it sends the tokens received directly to the receiver as fallback behavior
     * @param _token the address of the token sent through the bridge
     * @param _amount the amount of tokens received at this contract through the cross-chain bridge
     * @param _srcChainId source chain ID
     * @param _message SwapRequest message that defines the swap behavior on this destination chain
     */
    function executeMessageWithTransfer(
        address, // _sender
        address _token,     //! Is this src or dest token address?
        uint256 _amount,
        uint64 _srcChainId,
        bytes memory _message,
        address // executor
    ) external payable onlyCBridgeMessageBus returns (IMessageReceiverApp.ExecutionStatus) {
        //! TODO TO BE ADJUSTED

        // make sure that bridged tokens have arrived already
        //? how 
        uint256 balance = IERC20(_token).balanceOf(address(this));
        if (balance < _amount) revert InsufficientBalance(_amount, balance);









        //! -----------------
        //! original code FROM HERE
        // SwapRequest memory m = abi.decode((_message), (SwapRequest));
        // require(_token == m.swap.path[0], "bridged token must be the same as the first token in destination swap path");
        // bytes32 id = _computeSwapRequestId(m.receiver, _srcChainId, uint64(block.chainid), _message);
        // uint256 dstAmount;
        // SwapStatus status = SwapStatus.Succeeded;

        // if (m.swap.path.length > 1) {
        //     bool ok = true;
        //     (ok, dstAmount) = _trySwap(m.swap, _amount);
        //     if (ok) {
        //         _sendToken(m.swap.path[m.swap.path.length - 1], dstAmount, m.receiver, m.nativeOut);
        //         status = SwapStatus.Succeeded;
        //     } else {
        //         // handle swap failure, send the received token directly to receiver
        //         _sendToken(_token, _amount, m.receiver, false);
        //         dstAmount = _amount;
        //         status = SwapStatus.Fallback;
        //     }
        // } else {
        //     // no need to swap, directly send the bridged token to user
        //     _sendToken(m.swap.path[0], _amount, m.receiver, m.nativeOut);
        //     dstAmount = _amount;
        //     status = SwapStatus.Succeeded;
        // }
        // emit SwapRequestDone(id, dstAmount, status);
        // // always return success since swap failure is already handled in-place
        // return ExecutionStatus.Success;
    }



    

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    function swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver
    ) external payable nonReentrant {
        if (LibAsset.isNativeAsset(assetId)) {
            _swapAndCompleteBridgeTokens(_transactionId, _swapData, assetId, receiver, msg.value);
        } else {
            uint256 allowance = IERC20(assetId).allowance(msg.sender, address(this));
            LibAsset.depositAsset(assetId, allowance);
            _swapAndCompleteBridgeTokens(_transactionId, _swapData, assetId, receiver, allowance);
        }
    }

    /// @notice Send remaining token to receiver
    /// @param assetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function pullToken(
        address assetId,
        address payable receiver,
        uint256 amount
    ) external onlyOwner {
        if (LibAsset.isNativeAsset(assetId)) {
            receiver.call{ value: amount }("");
        } else {
            IERC20(assetId).safeTransfer(receiver, amount);
        }
    }

    /// Private Methods ///

    /// @notice Performs a swap before completing a cross-chain transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _swapData array of data needed for swaps
    /// @param assetId token received from the other chain
    /// @param receiver address that will receive tokens in the end
    /// @param amount amount of token
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount
    ) private {
        bool success;

        if (LibAsset.isNativeAsset(assetId)) {
            try executor.swapAndCompleteBridgeTokens{ value: amount }(_transactionId, _swapData, assetId, receiver) {
                success = true;
            } catch {
                receiver.call{ value: amount }("");
            }
        } else {
            IERC20 token = IERC20(assetId);
            token.safeApprove(address(executor), 0);
            token.safeIncreaseAllowance(address(executor), amount);

            try executor.swapAndCompleteBridgeTokens(_transactionId, _swapData, assetId, receiver) {
                success = true;
            } catch {
                token.safeTransfer(receiver, amount);
            }

            token.safeApprove(address(executor), 0);
        }

        if (!success) {
            emit LiFiTransferCompleted(_transactionId, assetId, receiver, amount, block.timestamp);
        }
    }
}
