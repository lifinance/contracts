// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IDlnSource } from "../Interfaces/IDlnSource.sol";

/// @title DeBridgeDLN Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through DeBridge DLN
/// @custom:version 1.0.0
contract DeBridgeDlnFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;
    IDlnSource public immutable dlnSource;

    /// Types ///

    /// @param receivingAssetId The address of the asset to receive
    /// @param receiver The address of the receiver
    /// @param minAmountOut The minimum amount to receive on the destination chain
    struct DeBridgeDlnData {
        bytes receivingAssetId;
        bytes receiver;
        uint256 minAmountOut;
    }

    /// Events ///

    event DlnOrderCreated(bytes32 indexed orderId);

    event BridgeToNonEVMChain(
        bytes32 indexed transactionId,
        uint256 indexed destinationChainId,
        bytes receiver
    );

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _dlnSource The address of the DLN order creation contract
    constructor(IDlnSource _dlnSource) {
        dlnSource = _dlnSource;
    }

    /// External Methods ///

    /// @notice Bridges tokens via DeBridgeDLN
    /// @param _bridgeData The core information needed for bridging
    /// @param _deBridgeDlnData Data specific to DeBridgeDLN
    function startBridgeTokensViaDeBridgeDln(
        ILiFi.BridgeData memory _bridgeData,
        DeBridgeDlnData calldata _deBridgeDlnData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(
            _bridgeData,
            _deBridgeDlnData,
            dlnSource.globalFixedNativeFee()
        );
    }

    /// @notice Performs a swap before bridging via DeBridgeDLN
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _deBridgeDlnData Data specific to DeBridgeDLN
    function swapAndStartBridgeTokensViaDeBridgeDln(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        DeBridgeDlnData calldata _deBridgeDlnData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        uint256 fee = dlnSource.globalFixedNativeFee();
        address assetId = _bridgeData.sendingAssetId;
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            LibAsset.isNativeAsset(assetId) ? 0 : fee
        );
        _startBridge(_bridgeData, _deBridgeDlnData, fee);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via DeBridgeDLN
    /// @param _bridgeData The core information needed for bridging
    /// @param _deBridgeDlnData Data specific to DeBridgeDLN
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        DeBridgeDlnData calldata _deBridgeDlnData,
        uint256 _fee
    ) internal {
        IDlnSource.OrderCreation memory orderCreation = IDlnSource
            .OrderCreation({
                giveTokenAddress: _bridgeData.sendingAssetId,
                giveAmount: _bridgeData.minAmount,
                takeTokenAddress: _deBridgeDlnData.receivingAssetId,
                takeAmount: _deBridgeDlnData.minAmountOut,
                takeChainId: _bridgeData.destinationChainId,
                receiverDst: _deBridgeDlnData.receiver,
                givePatchAuthoritySrc: _bridgeData.receiver,
                orderAuthorityAddressDst: _deBridgeDlnData.receiver,
                allowedTakerDst: "",
                externalCall: "",
                allowedCancelBeneficiarySrc: ""
            });

        bytes32 orderId;
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Give the DLN Source approval to bridge tokens
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(dlnSource),
                _bridgeData.minAmount
            );

            orderId = dlnSource.createOrder{ value: _fee }(
                orderCreation,
                "",
                0,
                ""
            );
        } else {
            orderCreation.giveAmount = orderCreation.giveAmount - _fee;
            orderId = dlnSource.createOrder{ value: _bridgeData.minAmount }(
                orderCreation,
                "",
                0,
                ""
            );
        }

        emit DlnOrderCreated(orderId);

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _deBridgeDlnData.receiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
