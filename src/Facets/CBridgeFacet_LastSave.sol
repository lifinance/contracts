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
import { MessageApp, MsgDataTypes, IMessageBus } from "celer-network/contracts/message/framework/MessageApp.sol";
import { console } from "forge-std/console.sol";


import { ERC20 } from "solmate/tokens/ERC20.sol";



// interface IMessageBus {
//     function feeBase() external view returns (uint256);
//     function feePerByte() external view returns (uint256);
// }

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
contract CBridgeFacet is ILiFi, ReentrancyGuard, MessageApp, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;
    IMessageBus private immutable cBridgeMessageBus;

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
        address messageBusAddress;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge, IMessageBus _messageBus) MessageApp(address(_messageBus)) {
        //TODO QUESTION: the _messageBus address is not available in the diamond later on. How to do that?
        // console.log("_messageBus: %s", _messageBus);
        // setMessageBus(_messageBus);
        console.log("messageBus: %s", messageBus);
        cBridge = _cBridge;
        cBridgeMessageBus = _messageBus;
    }

    // TODO: add init function and let it store messageBusAddress (as well as transfer Ownership)?


    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function startBridgeTokensViaCBridge(ILiFi.BridgeData memory _bridgeData, CBridgeData calldata _cBridgeData)
        external
        payable
        refundExcessNative(payable(msg.sender))     //! returns remaining gas to sender after function
        doesNotContainSourceSwaps(_bridgeData)      //! makes sure that BridgeData does not contains swap info
        // doesNotContainDestinationCalls(_bridgeData) //! receiver != address(0) && minAmount != 0
        validateBridgeData(_bridgeData)             //! prevents usage of native asset as sendingAssetId
        nonReentrant
    {
        console.log("and now here");
        console.log("fee %s", _cBridgeData.messageBusFee);
        console.log("%s", _bridgeData.hasDestinationCall);
        console.log("%s", _cBridgeData.callData.length);
        validateDestinationCallFlag(_bridgeData, _cBridgeData); //* added by me
        console.log(1);
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        console.log(2);
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
        // doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {   
        validateDestinationCallFlag(_bridgeData, _cBridgeData); //* added by me
        IERC20 dai = IERC20(_swapData[0].sendingAssetId);
        IERC20 usdc = IERC20(_swapData[0].receivingAssetId);
        console.log("---------------*******------------------");
        uint256 initialBalanceUSDC = usdc.balanceOf(msg.sender);
        uint256 initialBalanceDAI = dai.balanceOf(msg.sender);
        console.log("balance USD Whale bef: %s", initialBalanceUSDC);
        console.log("balance DAI Whale bef: %s", initialBalanceDAI);
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );

        console.log("change USDC balance mid: %s", initialBalanceUSDC - usdc.balanceOf(msg.sender));
        console.log("change DAI balance  mid: %s", initialBalanceDAI - dai.balanceOf(msg.sender));
        console.log("---------------*******------------------");

        _startBridge(_bridgeData, _cBridgeData);
        console.log("balance USD Whale aft: %s", usdc.balanceOf(msg.sender));
        console.log("balance DAI Whale aft: %s", dai.balanceOf(msg.sender));
        console.log("---------------*******------------------");
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _bridgeData the core information needed for bridging
    /// @param _cBridgeData data specific to CBridge
    function _startBridge(ILiFi.BridgeData memory _bridgeData, CBridgeData memory _cBridgeData) private {
        // Do CBridge stuff
        if (uint64(block.chainid) == _bridgeData.destinationChainId) revert CannotBridgeToSameNetwork();

        //TODO QUESTION: Does Lifi currently support cross-chain messages only or does it only work in 
        //TODO           combination with a bridging?
        
        // check if transaction has a destination call
        if (!_bridgeData.hasDestinationCall) {
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
        }
        else {
            // tx has destination call

            //! ######################
            //  ######## NEW #########
            //! ######################


            // compute SwapRequestId
            //! OPTION 1 - replace code above
            // bytes32 id = _computeSwapRequestId(msg.sender, block.chainId, _bridgeData.destinationChainId, _cBridgeData.callData);
            uint64 id = uint64(block.timestamp) ;
            //TODO ^^use timestamp as written in MessageSenderApp.sol or calculate as in example contract?
            
            // set messageBusAddress
            console.log("message bus address bef%s", messageBus);
            setMessageBus(_cBridgeData.messageBusAddress);      //TODO this must be moved
            console.log("message bus address aft%s", messageBus);

            // calculate fee for message bus as described in docs
            // uint256 feeBase = IMessageBus(_cBridgeData.messageBusAddress).feeBase();
            // uint256 feePerByte = IMessageBus(_cBridgeData.messageBusAddress).feePerByte();
            // _cBridgeData.messageBusFee = feeBase + _cBridgeData.callData.length * feePerByte;
            _cBridgeData.messageBusFee = IMessageBus(_cBridgeData.messageBusAddress).calcFee(_cBridgeData.callData);
            // _cBridgeData.messageBusFee = cBridgeMessageBus.calcFee(_cBridgeData.callData);


            // send message through messageBus
            _sendMessageWithTransfer(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount,
                uint64(_bridgeData.destinationChainId),
                id,
                _cBridgeData.maxSlippage,
                _cBridgeData.callData,
                MsgDataTypes.BridgeSendType.Liquidity,
                _cBridgeData.messageBusFee
            );
        }
        emit LiFiTransferStarted(_bridgeData);
    }

    function setMessageBus(address _messageBus) public override {
        messageBus = _messageBus;
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

    function _sendMessageWithTransfer(
        address _receiver,
        address _token,
        uint256 _amount,
        uint64 _dstChainId,
        uint64 _nonce,
        uint32 _maxSlippage,
        bytes memory _message,
        MsgDataTypes.BridgeSendType _bridgeSendType,
        uint256 _fee
    ) private returns (bytes32 transferId) {
        transferId = sendMessageWithTransfer(
            _receiver,
            _token,
            _amount,
            _dstChainId,
            _nonce,
            _maxSlippage,
            _message,
            _bridgeSendType,
            _fee
        );

        if (transferId.length == 0) revert CannotBridgeToSameNetwork();
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
