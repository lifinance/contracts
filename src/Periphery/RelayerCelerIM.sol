// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ContractCallNotAllowed, ExternalCallFailed, InvalidConfig, UnAuthorized, WithdrawFailed } from "../Errors/GenericErrors.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { PeripheryRegistryFacet } from "../Facets/PeripheryRegistryFacet.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { IMessageReceiverApp } from "celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";
import { CelerIM } from "lifi/Helpers/CelerIMFacetBase.sol";
import { MessageSenderLib, MsgDataTypes, IMessageBus, IOriginalTokenVault, IPeggedTokenBridge, IOriginalTokenVaultV2, IPeggedTokenBridgeV2 } from "celer-network/contracts/message/libraries/MessageSenderLib.sol";
import { IBridge as ICBridge } from "celer-network/contracts/interfaces/IBridge.sol";

/// @title RelayerCelerIM
/// @author LI.FI (https://li.fi)
/// @notice Relayer contract for CelerIM that forwards calls and handles refunds on src side and acts receiver on dest
/// @custom:version 2.0.1
contract RelayerCelerIM is ILiFi, TransferrableOwnership {
    using SafeERC20 for IERC20;

    /// Storage ///

    IMessageBus public cBridgeMessageBus;
    address public diamondAddress;

    /// Events ///

    event LogWithdraw(
        address indexed _assetAddress,
        address indexed _to,
        uint256 amount
    );

    /// Modifiers ///

    modifier onlyCBridgeMessageBus() {
        if (msg.sender != address(cBridgeMessageBus)) revert UnAuthorized();
        _;
    }
    modifier onlyDiamond() {
        if (msg.sender != diamondAddress) revert UnAuthorized();
        _;
    }

    /// Constructor

    constructor(
        address _cBridgeMessageBusAddress,
        address _owner,
        address _diamondAddress
    ) TransferrableOwnership(_owner) {
        owner = _owner;
        cBridgeMessageBus = IMessageBus(_cBridgeMessageBusAddress);
        diamondAddress = _diamondAddress;
    }

    /// External Methods ///

    /**
     * @notice Called by MessageBus to execute a message with an associated token transfer.
     * The Receiver is guaranteed to have received the right amount of tokens before this function is called.
     * @param * (unused) The address of the source app contract
     * @param _token The address of the token that comes out of the bridge
     * @param _amount The amount of tokens received at this contract through the cross-chain bridge.
     * @param * (unused)  The source chain ID where the transfer is originated from
     * @param _message Arbitrary message bytes originated from and encoded by the source app contract
     * @param * (unused)  Address who called the MessageBus execution function
     */
    function executeMessageWithTransfer(
        address,
        address _token,
        uint256 _amount,
        uint64,
        bytes calldata _message,
        address
    )
        external
        payable
        onlyCBridgeMessageBus
        returns (IMessageReceiverApp.ExecutionStatus)
    {
        // decode message
        (
            bytes32 transactionId,
            LibSwap.SwapData[] memory swapData,
            address receiver,
            address refundAddress
        ) = abi.decode(
                _message,
                (bytes32, LibSwap.SwapData[], address, address)
            );

        // update fromAmount in first swapData element with bridged amount
        LibSwap.SwapData[] memory swapDataNew = LibSwap
            .updateFromAmountInSwapData(swapData, _amount);

        _swapAndCompleteBridgeTokens(
            transactionId,
            swapDataNew,
            _token,
            payable(receiver),
            _amount,
            refundAddress
        );

        return IMessageReceiverApp.ExecutionStatus.Success;
    }

    /**
     * @notice Called by MessageBus to process refund of the original transfer from this contract.
     * The contract is guaranteed to have received the refund before this function is called.
     * @param _token The token address of the original transfer
     * @param _amount The amount of the original transfer
     * @param _message The same message associated with the original transfer
     * @param * (unused) Address who called the MessageBus execution function
     */
    function executeMessageWithTransferRefund(
        address _token,
        uint256 _amount,
        bytes calldata _message,
        address
    )
        external
        payable
        onlyCBridgeMessageBus
        returns (IMessageReceiverApp.ExecutionStatus)
    {
        (bytes32 transactionId, , , address refundAddress) = abi.decode(
            _message,
            (bytes32, LibSwap.SwapData[], address, address)
        );

        // return funds to cBridgeData.refundAddress
        LibAsset.transferAsset(_token, payable(refundAddress), _amount);

        emit LiFiTransferRecovered(
            transactionId,
            _token,
            refundAddress,
            _amount,
            block.timestamp
        );

        return IMessageReceiverApp.ExecutionStatus.Success;
    }

    /**
     * @notice Forwards a call to transfer tokens to cBridge (sent via this contract to ensure that potential refunds are sent here)
     * @param _bridgeData the core information needed for bridging
     * @param _celerIMData data specific to CelerIM
     */
    // solhint-disable-next-line code-complexity
    function sendTokenTransfer(
        ILiFi.BridgeData memory _bridgeData,
        CelerIM.CelerIMData calldata _celerIMData
    )
        external
        payable
        onlyDiamond
        returns (bytes32 transferId, address bridgeAddress)
    {
        // approve to and call correct bridge depending on BridgeSendType
        // @dev copied and slightly adapted from Celer MessageSenderLib
        if (_celerIMData.bridgeType == MsgDataTypes.BridgeSendType.Liquidity) {
            bridgeAddress = cBridgeMessageBus.liquidityBridge();
            if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
                // case: native asset bridging
                ICBridge(bridgeAddress).sendNative{
                    value: _bridgeData.minAmount
                }(
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _celerIMData.nonce,
                    _celerIMData.maxSlippage
                );
            } else {
                // case: ERC20 asset bridging
                LibAsset.maxApproveERC20(
                    IERC20(_bridgeData.sendingAssetId),
                    bridgeAddress,
                    _bridgeData.minAmount
                );
                // solhint-disable-next-line check-send-result
                ICBridge(bridgeAddress).send(
                    _bridgeData.receiver,
                    _bridgeData.sendingAssetId,
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _celerIMData.nonce,
                    _celerIMData.maxSlippage
                );
            }
            transferId = MessageSenderLib.computeLiqBridgeTransferId(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _celerIMData.nonce
            );
        } else if (
            _celerIMData.bridgeType == MsgDataTypes.BridgeSendType.PegDeposit
        ) {
            bridgeAddress = cBridgeMessageBus.pegVault();
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                bridgeAddress,
                _bridgeData.minAmount
            );
            IOriginalTokenVault(bridgeAddress).deposit(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _bridgeData.receiver,
                _celerIMData.nonce
            );
            transferId = MessageSenderLib.computePegV1DepositId(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _celerIMData.nonce
            );
        } else if (
            _celerIMData.bridgeType == MsgDataTypes.BridgeSendType.PegBurn
        ) {
            bridgeAddress = cBridgeMessageBus.pegBridge();
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                bridgeAddress,
                _bridgeData.minAmount
            );
            IPeggedTokenBridge(bridgeAddress).burn(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _bridgeData.receiver,
                _celerIMData.nonce
            );
            transferId = MessageSenderLib.computePegV1BurnId(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _celerIMData.nonce
            );
        } else if (
            _celerIMData.bridgeType == MsgDataTypes.BridgeSendType.PegV2Deposit
        ) {
            bridgeAddress = cBridgeMessageBus.pegVaultV2();
            if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
                // case: native asset bridging
                transferId = IOriginalTokenVaultV2(bridgeAddress)
                    .depositNative{ value: _bridgeData.minAmount }(
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _bridgeData.receiver,
                    _celerIMData.nonce
                );
            } else {
                // case: ERC20 bridging
                LibAsset.maxApproveERC20(
                    IERC20(_bridgeData.sendingAssetId),
                    bridgeAddress,
                    _bridgeData.minAmount
                );
                transferId = IOriginalTokenVaultV2(bridgeAddress).deposit(
                    _bridgeData.sendingAssetId,
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _bridgeData.receiver,
                    _celerIMData.nonce
                );
            }
        } else if (
            _celerIMData.bridgeType == MsgDataTypes.BridgeSendType.PegV2Burn
        ) {
            bridgeAddress = cBridgeMessageBus.pegBridgeV2();
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                bridgeAddress,
                _bridgeData.minAmount
            );
            transferId = IPeggedTokenBridgeV2(bridgeAddress).burn(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _bridgeData.receiver,
                _celerIMData.nonce
            );
        } else if (
            _celerIMData.bridgeType ==
            MsgDataTypes.BridgeSendType.PegV2BurnFrom
        ) {
            bridgeAddress = cBridgeMessageBus.pegBridgeV2();
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                bridgeAddress,
                _bridgeData.minAmount
            );
            transferId = IPeggedTokenBridgeV2(bridgeAddress).burnFrom(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _bridgeData.receiver,
                _celerIMData.nonce
            );
        } else {
            revert InvalidConfig();
        }
    }

    /**
     * @notice Forwards a call to the CBridge Messagebus
     * @param _receiver The address of the destination app contract.
     * @param _dstChainId The destination chain ID.
     * @param _srcBridge The bridge contract to send the transfer with.
     * @param _srcTransferId The transfer ID.
     * @param _dstChainId The destination chain ID.
     * @param _message Arbitrary message bytes to be decoded by the destination app contract.
     */
    function forwardSendMessageWithTransfer(
        address _receiver,
        uint256 _dstChainId,
        address _srcBridge,
        bytes32 _srcTransferId,
        bytes calldata _message
    ) external payable onlyDiamond {
        cBridgeMessageBus.sendMessageWithTransfer{ value: msg.value }(
            _receiver,
            _dstChainId,
            _srcBridge,
            _srcTransferId,
            _message
        );
    }

    // ------------------------------------------------------------------------------------------------

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
        uint256 amount,
        address refundAddress
    ) private {
        bool success;
        IExecutor executor = IExecutor(
            PeripheryRegistryFacet(diamondAddress).getPeripheryContract(
                "Executor"
            )
        );
        if (LibAsset.isNativeAsset(assetId)) {
            try
                executor.swapAndCompleteBridgeTokens{ value: amount }(
                    _transactionId,
                    _swapData,
                    assetId,
                    receiver
                )
            {
                success = true;
            } catch {
                // solhint-disable-next-line avoid-low-level-calls
                (bool fundsSent, ) = refundAddress.call{ value: amount }("");
                if (!fundsSent) {
                    revert ExternalCallFailed();
                }
            }
        } else {
            IERC20 token = IERC20(assetId);
            token.safeApprove(address(executor), 0);
            token.safeIncreaseAllowance(address(executor), amount);

            try
                executor.swapAndCompleteBridgeTokens(
                    _transactionId,
                    _swapData,
                    assetId,
                    receiver
                )
            {
                success = true;
            } catch {
                token.safeTransfer(refundAddress, amount);
            }
            token.safeApprove(address(executor), 0);
        }

        if (!success) {
            emit LiFiTransferRecovered(
                _transactionId,
                assetId,
                refundAddress,
                amount,
                block.timestamp
            );
        }
    }

    /// @notice Sends remaining token to given receiver address (for refund cases)
    /// @param assetId Address of the token to be withdrawn
    /// @param receiver Address that will receive tokens
    /// @param amount Amount of tokens to be withdrawn
    function withdraw(
        address assetId,
        address payable receiver,
        uint256 amount
    ) external onlyOwner {
        if (LibAsset.isNativeAsset(assetId)) {
            // solhint-disable-next-line avoid-low-level-calls
            (bool success, ) = receiver.call{ value: amount }("");
            if (!success) {
                revert WithdrawFailed();
            }
        } else {
            IERC20(assetId).safeTransfer(receiver, amount);
        }
        emit LogWithdraw(assetId, receiver, amount);
    }

    /// @notice Triggers a cBridge refund with calldata produced by cBridge API
    /// @param _callTo The address to execute the calldata on
    /// @param _callData The data to execute
    /// @param _assetAddress Asset to be withdrawn
    /// @param _to Address to withdraw to
    /// @param _amount Amount of asset to withdraw
    function triggerRefund(
        address payable _callTo,
        bytes calldata _callData,
        address _assetAddress,
        address _to,
        uint256 _amount
    ) external onlyOwner {
        bool success;

        // make sure that callTo address is either of the cBridge addresses
        if (
            cBridgeMessageBus.liquidityBridge() != _callTo &&
            cBridgeMessageBus.pegBridge() != _callTo &&
            cBridgeMessageBus.pegBridgeV2() != _callTo &&
            cBridgeMessageBus.pegVault() != _callTo &&
            cBridgeMessageBus.pegVaultV2() != _callTo
        ) {
            revert ContractCallNotAllowed();
        }

        // call contract
        // solhint-disable-next-line avoid-low-level-calls
        (success, ) = _callTo.call(_callData);

        // forward funds to _to address and emit event, if cBridge refund successful
        if (success) {
            address sendTo = (LibUtil.isZeroAddress(_to)) ? msg.sender : _to;
            LibAsset.transferAsset(_assetAddress, payable(sendTo), _amount);
            emit LogWithdraw(_assetAddress, sendTo, _amount);
        } else {
            revert WithdrawFailed();
        }
    }

    // required in order to receive native tokens from cBridge facet
    // solhint-disable-next-line no-empty-blocks
    receive() external payable {}
}
