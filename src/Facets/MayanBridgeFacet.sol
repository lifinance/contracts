// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IMayanBridge } from "../Interfaces/IMayanBridge.sol";

/// @title MayanBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Mayan Bridge
/// @custom:version 1.0.0
contract MayanBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address internal constant NON_EVM_ADDRESS =
        0x11f111f111f111F111f111f111F111f111f111F1;

    IMayanBridge public immutable mayanBridge;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param exampleParam Example paramter
    struct MayanBridgeData {
        bytes32 mayanAddr;
        uint16 mayanChainId;
        bytes32 auctionAddr;
        bytes32 referrer;
        bytes32 tokenOutAddr;
        uint64 swapFee;
        uint64 redeemFee;
        uint64 refundFee;
        uint256 transferDeadline;
        uint64 swapDeadline;
        uint64 amountOutMin;
        bool unwrap;
        uint64 gasDrop;
    }

    /// Events ///

    /// Constructor ///

    /// @notice Constructor for the contract.
    constructor(IMayanBridge _mayanBridge) {
        mayanBridge = _mayanBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via MayanBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanBridgeData Data specific to MayanBridge
    function startBridgeTokensViaMayanBridge(
        ILiFi.BridgeData memory _bridgeData,
        MayanBridgeData calldata _mayanBridgeData
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
        _startBridge(_bridgeData, _mayanBridgeData);
    }

    /// @notice Performs a swap before bridging via MayanBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _mayanBridgeData Data specific to MayanBridge
    function swapAndStartBridgeTokensViaMayanBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        MayanBridgeData calldata _mayanBridgeData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _mayanBridgeData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via MayanBridge
    /// @param _bridgeData The core information needed for bridging
    /// @param _mayanBridgeData Data specific to MayanBridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        MayanBridgeData calldata _mayanBridgeData
    ) internal {
        bytes32 receiver = bytes32(uint256(uint160(_bridgeData.receiver)));
        uint256 totalFees = _mayanBridgeData.swapFee +
            _mayanBridgeData.redeemFee +
            _mayanBridgeData.refundFee;

        IMayanBridge.RelayerFees memory relayerFees = IMayanBridge
            .RelayerFees({
                swapFee: _mayanBridgeData.swapFee,
                redeemFee: _mayanBridgeData.redeemFee,
                refundFee: _mayanBridgeData.refundFee
            });

        IMayanBridge.Recepient memory recipient = IMayanBridge.Recepient({
            mayanAddr: _mayanBridgeData.mayanAddr,
            mayanChainId: _mayanBridgeData.mayanChainId,
            auctionAddr: _mayanBridgeData.auctionAddr,
            destAddr: receiver,
            destChainId: uint16(_bridgeData.destinationChainId),
            referrer: _mayanBridgeData.referrer,
            refundAddr: receiver
        });

        IMayanBridge.Criteria memory criteria = IMayanBridge.Criteria({
            transferDeadline: _mayanBridgeData.transferDeadline,
            swapDeadline: _mayanBridgeData.swapDeadline,
            amountOutMin: _mayanBridgeData.amountOutMin,
            unwrap: _mayanBridgeData.unwrap,
            gasDrop: _mayanBridgeData.gasDrop,
            customPayload: ""
        });

        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            mayanBridge.wrapAndSwapETH{ value: totalFees }(
                relayerFees,
                recipient,
                _mayanBridgeData.tokenOutAddr,
                uint16(_bridgeData.destinationChainId),
                criteria
            );
        } else {
            mayanBridge.swap{ value: _bridgeData.minAmount }(
                relayerFees,
                recipient,
                _mayanBridgeData.tokenOutAddr,
                uint16(_bridgeData.destinationChainId),
                criteria,
                _bridgeData.sendingAssetId,
                _bridgeData.minAmount
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
