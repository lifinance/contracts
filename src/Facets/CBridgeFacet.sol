// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICBridge } from "../Interfaces/ICBridge.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InvalidReceiver, InvalidAmount, InvalidCaller, InvalidConfig, InformationMismatch, CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { MessageSenderLib, MsgDataTypes, IMessageBus } from "celer-network/contracts/message/libraries/MessageSenderLib.sol";
import { console } from "forge-std/console.sol";
import { ERC20 } from "solmate/tokens/ERC20.sol";
import { IMessageReceiverApp } from "celer-network/contracts/message/interfaces/IMessageReceiverApp.sol";

interface IOriginalTokenVault {
    function deposit(
        address _token,
        uint256 _amount,
        uint64 _mintChainId,
        address _mintAccount,
        uint64 _nonce
    ) external;

    function depositNative(
        uint256 _amount,
        uint64 _mintChainId,
        address _mintAccount,
        uint64 _nonce
    ) external payable;
}

interface IPeggedTokenBridge {
    function burn(
        address _token,
        uint256 _amount,
        address _withdrawAccount,
        uint64 _nonce
    ) external;
}

interface IOriginalTokenVaultV2 {
    function deposit(
        address _token,
        uint256 _amount,
        uint64 _mintChainId,
        address _mintAccount,
        uint64 _nonce
    ) external returns (bytes32);

    function depositNative(
        uint256 _amount,
        uint64 _mintChainId,
        address _mintAccount,
        uint64 _nonce
    ) external payable returns (bytes32);
}

interface IPeggedTokenBridgeV2 {
    function burn(
        address _token,
        uint256 _amount,
        uint64 _toChainId,
        address _toAccount,
        uint64 _nonce
    ) external returns (bytes32);

    function burnFrom(
        address _token,
        uint256 _amount,
        uint64 _toChainId,
        address _toAccount,
        uint64 _nonce
    ) external returns (bytes32);
}

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
contract CBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    event CelerIMMessageWithTransferRefunded(bytes32 indexed transactionId, address indexed refundAddress);

    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;
    IMessageBus public immutable cBridgeMessageBus;

    /// Types ///

    /// @param maxSlippage The max slippage accepted, given as percentage in point (pip).
    /// @param nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
    struct CBridgeData {
        uint32 maxSlippage;
        uint64 nonce;
        //added from here
        bytes callTo;
        bytes callData;
        uint256 messageBusFee;
        MsgDataTypes.BridgeSendType bridgeType;
    }

    /// Modifiers ///
    modifier onlyCBridgeMessageBus() {
        if (msg.sender != address(cBridgeMessageBus)) revert InvalidCaller();
        _;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge, IMessageBus _messageBus) {
        cBridge = _cBridge;
        cBridgeMessageBus = _messageBus;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function startBridgeTokensViaCBridge(ILiFi.BridgeData memory _bridgeData, CBridgeData calldata _cBridgeData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        validateDestinationCallFlag(_bridgeData, _cBridgeData);
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _cBridgeData);
    }

    /// @notice Performs a swap before bridging via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _cBridgeData data specific to CBridge
    function swapAndStartBridgeTokensViaCBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        CBridgeData memory _cBridgeData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        validateDestinationCallFlag(_bridgeData, _cBridgeData);

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        _startBridge(_bridgeData, _cBridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function _startBridge(ILiFi.BridgeData memory _bridgeData, CBridgeData memory _cBridgeData) private {
        // Do CBridge stuff
        if (uint64(block.chainid) == _bridgeData.destinationChainId) revert CannotBridgeToSameNetwork();

        // transfer tokens
        (bytes32 transferId, address bridgeAddress) = _sendTokenTransfer(_bridgeData, _cBridgeData);

        // assuming messageBusFee is pre-calculated off-chain

        // check if transaction contains a destination call
        if (_bridgeData.hasDestinationCall) {
            // send message
            cBridgeMessageBus.sendMessageWithTransfer{ value: _cBridgeData.messageBusFee }(
                _bridgeData.receiver,
                uint64(_bridgeData.destinationChainId),
                address(cBridge),
                transferId,
                _cBridgeData.callData
            );
        }

        // emit LiFi event
        emit LiFiTransferStarted(_bridgeData);
    }

    function validateDestinationCallFlag(ILiFi.BridgeData memory _bridgeData, CBridgeData memory _cBridgeData)
        private
        pure
    {
        if ((_cBridgeData.callData.length > 0) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
        }
    }

    // initiates a cross-chain token transfer using cBridge
    function _sendTokenTransfer(ILiFi.BridgeData memory _bridgeData, CBridgeData memory _cBridgeData)
        private
        returns (bytes32 transferId, address bridgeAddress)
    {
        // !------------ new implementation for bridge type 1 (=LIQUIDITY) only
        // if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
        //     // TODO make sure that native transfers can only be sent via xLiquidity bridge
        //     if (_cBridgeData.bridgeType != MsgDataTypes.BridgeSendType.Liquidity) revert InvalidConfig();
        //     if (msg.value < _bridgeData.minAmount) revert InformationMismatch(); //TODO add correct error
        //     cBridge.sendNative{value: _bridgeData.minAmount}(
        //         _bridgeData.receiver,
        //         _bridgeData.minAmount,
        //         uint64(_bridgeData.destinationChainId),
        //         _cBridgeData.nonce,
        //         _cBridgeData.maxSlippage
        //     );
        // } else {
        //     // Give CBridge approval to bridge tokens
        //     LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), address(cBridge), _bridgeData.minAmount);
        //     // solhint-disable check-send-result
        //     cBridge.send(
        //         _bridgeData.receiver,
        //         _bridgeData.sendingAssetId,
        //         _bridgeData.minAmount,
        //         uint64(_bridgeData.destinationChainId),
        //         _cBridgeData.nonce,
        //         _cBridgeData.maxSlippage
        //     );
        // }

        //!------------ new implementation for all bridge types
        // approve to and call correct bridge depending on BridgeSendType
        // @dev copied and slightly adapted from Celer MessageSenderLib
        if (_cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.Liquidity) {
            bridgeAddress = cBridgeMessageBus.liquidityBridge();
            if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
                // native asset
                if (msg.value < _bridgeData.minAmount) revert InformationMismatch(); //TODO add correct error
                ICBridge(bridgeAddress).sendNative{ value: _bridgeData.minAmount }(
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    uint64(_bridgeData.destinationChainId),
                    _cBridgeData.nonce,
                    _cBridgeData.maxSlippage
                );
            } else {
                // ERC20 asset
                LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), bridgeAddress, _bridgeData.minAmount);
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
        } else if (_cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegDeposit) {
            bridgeAddress = cBridgeMessageBus.pegVault();
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), bridgeAddress, _bridgeData.minAmount);
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
        } else if (_cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegBurn) {
            bridgeAddress = cBridgeMessageBus.pegBridge();
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), bridgeAddress, _bridgeData.minAmount);
            IPeggedTokenBridge(bridgeAddress).burn(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _bridgeData.receiver,
                _cBridgeData.nonce
            );
            // handle cases where certain tokens do not spend allowance for role-based burn
            // IERC20(_bridgeData.sendingAssetId).safeApprove(bridgeAddress, 0); //! do we need this?
            transferId = MessageSenderLib.computePegV1BurnId(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                _cBridgeData.nonce
            );
        } else if (_cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegV2Deposit) {
            // bridgeAddress = cBridgeMessageBus.pegVaultV2(); // TODO to be changed once CBridge updated their messageBus
            bridgeAddress = 0x7510792A3B1969F9307F3845CE88e39578f2bAE1;
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), bridgeAddress, _bridgeData.minAmount);
            transferId = IOriginalTokenVaultV2(bridgeAddress).deposit(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _bridgeData.receiver,
                _cBridgeData.nonce
            );
        } else if (_cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegV2Burn) {
            // bridgeAddress = cBridgeMessageBus.pegBridgeV2(); // TODO to be changed once CBridge updated their messageBus
            bridgeAddress = 0x52E4f244f380f8fA51816c8a10A63105dd4De084;
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), bridgeAddress, _bridgeData.minAmount);
            transferId = IPeggedTokenBridgeV2(bridgeAddress).burn(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _bridgeData.receiver,
                _cBridgeData.nonce
            );
            // handle cases where certain tokens do not spend allowance for role-based burn
            // IERC20(_bridgeData.sendingAssetId).safeApprove(bridgeAddress, 0);  //! do we need this?
        } else if (_cBridgeData.bridgeType == MsgDataTypes.BridgeSendType.PegV2BurnFrom) {
            // bridgeAddress = cBridgeMessageBus.pegBridgeV2(); // TODO to be changed once CBridge updated their messageBus
            bridgeAddress = 0x52E4f244f380f8fA51816c8a10A63105dd4De084;
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), bridgeAddress, _bridgeData.minAmount);
            transferId = IPeggedTokenBridgeV2(bridgeAddress).burnFrom(
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _bridgeData.receiver,
                _cBridgeData.nonce
            );
            // handle cases where certain tokens do not spend allowance for role-based burn
            // IERC20(_bridgeData.sendingAssetId).safeApprove(bridgeAddress, 0);  //! do we need this?
        } else {
            revert InvalidConfig();
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

    function _computeTransferId(
        address _receiver,
        address _token,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce
    ) private view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(address(this), _receiver, _token, _amount, _dstChainId, _nonce, uint64(block.chainid))
            );
    }

    /**
     * @notice Called by MessageBus to process refund of the original transfer from this contract.
     * The contract is guaranteed to have received the refund before this function is called.
     * @param _token The token address of the original transfer
     * @param _amount The amount of the original transfer
     * @param _message The same message associated with the original transfer
     * @param _executor Address who called the MessageBus execution function
     */
    function executeMessageWithTransferRefund(
        address _token,
        uint256 _amount,
        bytes calldata _message,
        address _executor
    ) external payable onlyCBridgeMessageBus returns (IMessageReceiverApp.ExecutionStatus) {
        (bytes32 transactionId, LibSwap.SwapData[] memory swapData, address receiver, address refundAddress) = abi
            .decode(_message, (bytes32, LibSwap.SwapData[], address, address));

        // return funds to cBridgeData.refundAddress
        LibAsset.transferAsset(_token, payable(refundAddress), _amount);

        emit CelerIMMessageWithTransferRefunded(transactionId, refundAddress);

        return IMessageReceiverApp.ExecutionStatus.Success;
    }
}
