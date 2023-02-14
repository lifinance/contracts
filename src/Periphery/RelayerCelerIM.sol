// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { IERC20, SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { UnAuthorized, InvalidConfig, InsufficientBalance, NotAContract, ContractCallNotAllowed, ExternalCallFailed } from "../Errors/GenericErrors.sol";
import { LibAllowList } from "../Libraries/LibAllowList.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibBytes } from "../Libraries/LibBytes.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IExecutor } from "../Interfaces/IExecutor.sol";
import { TransferrableOwnership } from "../Helpers/TransferrableOwnership.sol";
import { IMessageReceiverApp } from "celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";
import {CelerIMFacet} from "lifi/Facets/CelerIMFacet.sol";
import { MessageSenderLib, MsgDataTypes, IMessageBus, IOriginalTokenVault, IPeggedTokenBridge, IOriginalTokenVaultV2, IPeggedTokenBridgeV2 } from "celer-network/contracts/message/libraries/MessageSenderLib.sol";
import { IBridge as ICBridge } from "celer-network/contracts/interfaces/IBridge.sol";

/// @title RelayerCelerIM
/// @author LI.FI (https://li.fi)
/// @notice Relayer contract for CelerIM that forwards calls and handles refunds on src side and acts receiver on dest
contract RelayerCelerIM is ILiFi, ReentrancyGuard, TransferrableOwnership {
    using SafeERC20 for IERC20;

    /// Storage ///
    IMessageBus public cBridgeMessageBus;
    address public diamondAddress;
    IExecutor public executor;

    /// Errors ///

    /// Events ///
    event CBridgeMessageBusSet(address indexed messageBusAddress);
    event DiamondAddressSet(address indexed diamondAddress);
    event ExecutorSet(address indexed executorAddress);

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
        address _owner,
        address _cBridgeMessageBusAddress,
        address _diamondAddress,
        address _executorAddress
    ) TransferrableOwnership(_owner) {
        owner = _owner;
        cBridgeMessageBus = IMessageBus(_cBridgeMessageBusAddress);
        diamondAddress = _diamondAddress;
        executor = IExecutor(_executorAddress);
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

        _swapAndCompleteBridgeTokens(
            transactionId,
            swapData,
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
     * @param _cBridgeData data specific to CBridge
     */
    function sendTokenTransfer(
        ILiFi.BridgeData memory _bridgeData,
        CelerIMFacet.CelerIMData memory _cBridgeData
    )
        external
        payable
        onlyDiamond
        returns (bytes32 transferId, address bridgeAddress)
    {
        // approve to and call correct bridge depending on BridgeSendType
        // @dev copied and slightly adapted from Celer MessageSenderLib
        if (_cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.Liquidity) {
            bridgeAddress = cBridgeMessageBus.liquidityBridge();
            if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
                // case: native asset bridging
                ICBridge(bridgeAddress).sendNative{
                    value: _bridgeData.minAmount
                }(
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _cBridgeData.nonce,
                    _cBridgeData.maxSlippage
                );
            } else {
                // case: ERC20 asset bridging
                LibAsset.maxApproveERC20(
                    IERC20(_bridgeData.sendingAssetId),
                    bridgeAddress,
                    _bridgeData.minAmount
                );
                ICBridge(bridgeAddress).send(
                    _bridgeData.receiver,
                    _bridgeData.sendingAssetId,
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _cBridgeData.nonce,
                    _cBridgeData.maxSlippage
                );
            }
            transferId = MessageSenderLib.computeLiqBridgeTransferId(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce
            );
        } else if (
            _cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegDeposit
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
                _cBridgeData.nonce
            );
            transferId = MessageSenderLib.computePegV1DepositId(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce
            );
        } else if (
            _cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegBurn
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
                _cBridgeData.nonce
            );
            transferId = MessageSenderLib.computePegV1BurnId(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _cBridgeData.nonce
            );
        } else if (
            _cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegV2Deposit
        ) {
            bridgeAddress = cBridgeMessageBus.pegVaultV2();
            if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
                // case: native asset bridging
                transferId = IOriginalTokenVaultV2(bridgeAddress)
                    .depositNative{ value: _bridgeData.minAmount }(
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _bridgeData.receiver,
                    _cBridgeData.nonce
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
                    _cBridgeData.nonce
                );
            }
        } else if (
            _cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegV2Burn
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
                _cBridgeData.nonce
            );
        } else if (
            _cBridgeData.bridgeType ==
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
                _cBridgeData.nonce
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

    /// @notice sets the CBridge MessageBus address
    /// @param _messageBusAddress the MessageBus address
    function setCBridgeMessageBus(address _messageBusAddress)
        external
        onlyOwner
    {
        cBridgeMessageBus = IMessageBus(_messageBusAddress);
        emit CBridgeMessageBusSet(_messageBusAddress);
    }

    /// @notice sets the executor address
    /// @param _executorAddress the address of the executor contract
    function setExecutor(address _executorAddress) external onlyOwner {
        executor = IExecutor(_executorAddress);
        emit ExecutorSet(_executorAddress);
    }

    /// @notice sets the address of our diamond contract
    /// @param _diamondAddress the address of our diamond contract
    function setDiamondAddress(address _diamondAddress) external onlyOwner {
        diamondAddress = _diamondAddress;
        emit DiamondAddressSet(_diamondAddress);
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
                (bool fundsSent, ) = refundAddress.call{ value: amount }("");
                if (!fundsSent) revert ExternalCallFailed();
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
            receiver.call{ value: amount }("");
        } else {
            IERC20(assetId).safeTransfer(receiver, amount);
        }
    }

    // required in order to receive native tokens from cBridge facet
    receive() external payable {}
}
