// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";

/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
contract Receiver is ILiFi, ReentrancyGuard, TransferrableOwnership {
    using SafeERC20 for IERC20;

    /// Storage ///
    address public sgRouter;
    IExecutor public executor;

    /// Errors ///
    error InvalidStargateRouter();

    /// Events ///
    event StargateRouterSet(address indexed router);

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
        if (msg.sender != address(sgRouter)) {
            revert InvalidStargateRouter();
        }

        (bytes32 transactionId, LibSwap.SwapData[] memory swapData, , address receiver) = abi.decode(
            _payload,
            (bytes32, LibSwap.SwapData[], address, address)
        );

        _swapAndCompleteBridgeTokens(transactionId, swapData, _token, payable(receiver), _amountLD);
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
