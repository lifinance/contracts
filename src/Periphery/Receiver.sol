// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { UnAuthorized } from "../Errors/GenericErrors.sol";

/// @title Executor
/// @author LI.FI (https://li.fi)
/// @notice Arbitrary execution contract used for cross-chain swaps and message passing
contract Receiver is ILiFi, ReentrancyGuard, TransferrableOwnership {
    using SafeERC20 for IERC20;

    /// Storage ///
    address public sgRouter;
    IExecutor public executor;
    uint256 public recoverGas;
    address public amarokRouter;

    /// Errors ///

    /// Events ///
    event StargateRouterSet(address indexed router);
    event AmarokRouterSet(address indexed router);
    event ExecutorSet(address indexed executor);
    event RecoverGasSet(uint256 indexed recoverGas);
    event LiFiTransferRecovered(
        bytes32 indexed transactionId,
        address receivingAssetId,
        address receiver,
        uint256 amount,
        uint256 timestamp
    );

    /// Modifiers ///
    modifier onlySGRouter() {
        if (msg.sender != sgRouter) {
            revert UnAuthorized();
        }
        _;
    }
    modifier onlyAmarokRouter() {
        if (msg.sender != amarokRouter) {
            revert UnAuthorized();
        }
        _;
    }

    /// Constructor
    constructor(
        address _owner,
        address _sgRouter,
        address _amarokRouter,
        address _executor,
        uint256 _recoverGas
    ) TransferrableOwnership(_owner) {
        owner = _owner;
        sgRouter = _sgRouter;
        amarokRouter = _amarokRouter;
        executor = IExecutor(_executor);
        recoverGas = _recoverGas;
        emit StargateRouterSet(_sgRouter);
        emit AmarokRouterSet(_amarokRouter);
        emit RecoverGasSet(_recoverGas);
    }

    /// External Methods ///

    /// @notice set stargate router
    /// @param _sgRouter the stargate router address
    function setStargateRouter(address _sgRouter) external onlyOwner {
        sgRouter = _sgRouter;
        emit StargateRouterSet(_sgRouter);
    }

    /// @notice Sets the address of the Amarok router
    /// @param _amarokRouter the Amarok router address
    function setAmarokRouter(address _amarokRouter) external onlyOwner {
        amarokRouter = _amarokRouter;
        emit AmarokRouterSet(_amarokRouter);
    }

    /// @notice set Executor
    /// @param _executor the Executor address
    function setExecutor(address _executor) external onlyOwner {
        executor = IExecutor(_executor);
        emit ExecutorSet(_executor);
    }

    /// @notice set execution recoverGas
    /// @param _recoverGas recoverGas
    function setRecoverGas(uint256 _recoverGas) external onlyOwner {
        recoverGas = _recoverGas;
        emit RecoverGasSet(_recoverGas);
    }

    /// @notice Completes a cross-chain transaction with calldata via Amarok facet on the receiving chain.
    /// @dev This function is called from Stargate Router.
    /// @param _transferId The unique ID of this transaction (assigned by Amarok)
    /// @param _amount the amount of bridged tokens
    /// @param _asset the address of the bridged token
    /// @param * (unused) the sender of the transaction
    /// @param * (unused) the domain ID of the src chain
    /// @param _callData The data to execute
    function xReceive(
        bytes32 _transferId,
        uint256 _amount,
        address _asset,
        address,
        uint32,
        bytes memory _callData
    ) external nonReentrant onlyAmarokRouter {
        (LibSwap.SwapData[] memory swapData, address receiver) = abi.decode(_callData, (LibSwap.SwapData[], address));

        _swapAndCompleteBridgeTokens(_transferId, swapData, _asset, payable(receiver), _amount, false);
    }

    /// @notice Completes a cross-chain transaction on the receiving chain.
    /// @dev This function is called from Stargate Router.
    /// @param * (unused) The remote chainId sending the tokens
    /// @param * (unused) The remote Bridge address
    /// @param * (unused) Nonce
    /// @param * (unused) The token contract on the local chain
    /// @param _amountLD The amount of tokens received through bridging
    /// @param _payload The data to execute
    function sgReceive(
        uint16, // _srcChainId unused
        bytes memory, // _srcAddress unused
        uint256, // _nonce unused
        address _token,
        uint256 _amountLD,
        bytes memory _payload
    ) external nonReentrant onlySGRouter {
        (bytes32 transactionId, LibSwap.SwapData[] memory swapData, , address receiver) = abi.decode(
            _payload,
            (bytes32, LibSwap.SwapData[], address, address)
        );

        _swapAndCompleteBridgeTokens(transactionId, swapData, _token, payable(receiver), _amountLD, true);
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
            _swapAndCompleteBridgeTokens(_transactionId, _swapData, assetId, receiver, msg.value, false);
        } else {
            uint256 allowance = IERC20(assetId).allowance(msg.sender, address(this));
            LibAsset.depositAsset(assetId, allowance);
            _swapAndCompleteBridgeTokens(_transactionId, _swapData, assetId, receiver, allowance, false);
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
    /// @param reserveRecoverGas whether we need a gas buffer to recover
    function _swapAndCompleteBridgeTokens(
        bytes32 _transactionId,
        LibSwap.SwapData[] memory _swapData,
        address assetId,
        address payable receiver,
        uint256 amount,
        bool reserveRecoverGas
    ) private {
        uint256 _recoverGas = reserveRecoverGas ? recoverGas : 0;

        if (LibAsset.isNativeAsset(assetId)) {
            // case 1: native asset
            if (reserveRecoverGas && gasleft() < _recoverGas) {
                // case 1a: not enough gas left to execute calls
                receiver.call{ value: amount }("");

                emit LiFiTransferRecovered(_transactionId, assetId, receiver, amount, block.timestamp);
                return;
            }

            // case 1b: enough gas left to execute calls
            try
                executor.swapAndCompleteBridgeTokens{ value: amount, gas: gasleft() - _recoverGas }(
                    _transactionId,
                    _swapData,
                    assetId,
                    receiver
                )
            {} catch {
                receiver.call{ value: amount }("");
            }
        } else {
            // case 2: ERC20 asset
            IERC20 token = IERC20(assetId);
            token.safeApprove(address(executor), 0);
            token.safeIncreaseAllowance(address(executor), amount);

            if (reserveRecoverGas && gasleft() < _recoverGas) {
                // case 2a: not enough gas left to execute calls
                token.safeTransfer(receiver, amount);

                emit LiFiTransferRecovered(_transactionId, assetId, receiver, amount, block.timestamp);
                return;
            }

            // case 2b: enough gas left to execute calls
            try
                executor.swapAndCompleteBridgeTokens{ gas: gasleft() - _recoverGas }(
                    _transactionId,
                    _swapData,
                    assetId,
                    receiver
                )
            {} catch {
                token.safeTransfer(receiver, amount);
                emit LiFiTransferRecovered(_transactionId, assetId, receiver, amount, block.timestamp);
            }

            token.safeApprove(address(executor), 0);
        }
    }

    /// @notice Receive native asset directly.
    /// @dev Some bridges may send native asset before execute external calls.
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
