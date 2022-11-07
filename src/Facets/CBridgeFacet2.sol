// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICBridge } from "../Interfaces/ICBridge.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InvalidReceiver, InvalidAmount, InformationMismatch, CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { MessageApp } from "celer-network/contracts/message/framework/MessageApp.sol";

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
contract CBridgeFacet2 is ILiFi, ReentrancyGuard, SwapperV2, Validatable, MessageApp {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;

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
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge, address _messageBus) MessageApp(_messageBus) {
        cBridge = _cBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function startBridgeTokensViaCBridge(ILiFi.BridgeData memory _bridgeData, CBridgeData calldata _cBridgeData)
        external
        payable
        refundExcessNative(payable(msg.sender))     //! returns remaining gas to sender after function
        doesNotContainSourceSwaps(_bridgeData)      //! makes sure that BridgeData does not contains swap info
        doesNotContainDestinationCalls(_bridgeData) //! receiver != address(0) && minAmount != 0
        validateBridgeData(_bridgeData)             //! prevents usage of native asset as sendingAssetId
        nonReentrant
    {
        validateDestinationCallFlag(_bridgeData, _cBridgeData); //* added by me
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
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
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

        //TODO I think I need to switch here from sendNative()/send() to sendMessageWithTransfer() from 
        //TODO MessageSenderApp contract:
        // https://github.com/celer-network/sgn-v2-contracts/blob/1c65d5538ff8509c7e2626bb1a857683db775231/contracts/message/framework/MessageSenderApp.sol

        //TODO QUESTION: Does Lifi currently support cross-chain messages only or does it only work in 
        //TODO           combination with a bridging?
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            cBridge.sendNative{ value: _bridgeData.minAmount }(
                _bridgeData.receiver,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        } else {
            // Give CBridge approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), address(cBridge), _bridgeData.minAmount);
            // solhint-disable check-send-result
            cBridge.send(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        }

        //! ######################
        //  ######## NEW #########
        //! ######################
        

        // calculate fee for message bus as described in docs

        //! I think fee has to be calculated off-chain and passed into this function 
        //! (obtain values for 'feeBase' and 'feePerByte' from MessageBus)
        // _cBridgeData.messageBusFee = feeBase + _cBridgeData.callData.length * feePerByte;


        // compute SwapRequestId
        //! OPTION 1 - replace code above
        // bytes32 id = _computeSwapRequestId(msg.sender, block.chainId, _bridgeData.destinationChainId, _cBridgeData.callData);
        // bytes32 id = block.timestamp;
        
        //TODO ^^could this also only just be the timestamp as written in MessageSenderApp.sol?
        // sendMessageWithTransfer(
        //     _bridgeData.receiver,
        //     _bridgeData.sendingAssetId,
        //     _bridgeData.minAmount,
        //     _bridgeData.destinationChainId,
        //     id,
        //     _cBridgeData.maxSlippage,
        //     _cBridgeData.callData,
        //     MsgDataTypes.BridgeSendType
        // );

        
        bytes memory tmp = abi.encode(_cBridgeData.callData);
        //! OPTION 2 - extend code above
        //TODO Why does the compiler not call the function "sendMessage()" of MessageSenderApp.sol ????
        // sendMessage(
        //     _cBridgeData.callTo,                        //! address receiver            TYPE OK
        //     uint64(_bridgeData.destinationChainId),     //! uint64 destChainId          TYPE OK
        //     // _cBridgeData.callData,                   //! bytes memory message        TYPE ???
        //     tmp,                                        //! bytes memory message        TYPE ???
        //     _cBridgeData.messageBusFee                  //! uint256 fee                 TYPE OK
        // );

        emit LiFiTransferStarted(_bridgeData);
    }

    function executeMessage(
        address _sender,
        uint64 _srcChainId,
        bytes calldata _message,
        address _executor
    ) external payable virtual override onlyMessageBus returns (ExecutionStatus) {}

    function validateDestinationCallFlag(ILiFi.BridgeData memory _bridgeData, CBridgeData memory _cBridgeData)
        private
        pure
    {
        if ((_cBridgeData.callData.length > 0) != _bridgeData.hasDestinationCall) {
            revert InformationMismatch();
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
}


/// RESOURCES
// CBRIDGE DOCS for IM
// https://github.com/celer-network/sgn-v2-contracts/tree/1c65d5538ff8509c7e2626bb1a857683db775231/contracts/message

// SAMPLE CONTRACT
// https://github.com/celer-network/sgn-v2-contracts/blob/1c65d5538ff8509c7e2626bb1a857683db775231/contracts/message/apps/examples/TransferSwap.sol
