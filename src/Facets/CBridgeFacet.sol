// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICBridge } from "../Interfaces/ICBridge.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { CannotBridgeToSameNetwork } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { InvalidReceiver, InvalidAmount } from "../Errors/GenericErrors.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
contract CBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Storage ///

    /// @notice The contract address of the cbridge on the source chain.
    ICBridge private immutable cBridge;

    /// Types ///

    /// @param assetId The address of the token.
    /// @param amount The amount of the transfer.
    /// @param receiver The address of the receiver.
    /// @param dstChainId The destination chain ID.
    /// @param nonce A number input to guarantee uniqueness of transferId. Can be timestamp in practice.
    /// @param maxSlippage The max slippage accepted, given as percentage in point (pip).
    struct CBridgeData {
        address assetId;
        uint256 amount;
        address receiver;
        uint64 dstChainId;
        uint64 nonce;
        uint32 maxSlippage;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _cBridge The contract address of the cbridge on the source chain.
    constructor(ICBridge _cBridge) {
        cBridge = _cBridge;
    }

    /// External Methods ///

    /// @notice Bridges tokens via CBridge
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _cBridgeData data specific to CBridge
    function startBridgeTokensViaCBridge(LiFiData calldata _lifiData, CBridgeData calldata _cBridgeData)
        external
        payable
        nonReentrant
    {
        if (LibUtil.isZeroAddress(_cBridgeData.receiver)) {
            revert InvalidReceiver();
        }
        if (_cBridgeData.amount == 0) {
            revert InvalidAmount();
        }

        LibAsset.depositAsset(_cBridgeData.assetId, _cBridgeData.amount);
        _startBridge(_lifiData, _cBridgeData, false);
    }

    /// @notice Performs a swap before bridging via CBridge
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _cBridgeData data specific to CBridge
    function swapAndStartBridgeTokensViaCBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        CBridgeData memory _cBridgeData
    ) external payable nonReentrant {
        if (LibUtil.isZeroAddress(_cBridgeData.receiver)) {
            revert InvalidReceiver();
        }

        _cBridgeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _cBridgeData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _cBridgeData data specific to CBridge
    /// @param _hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        LiFiData calldata _lifiData,
        CBridgeData memory _cBridgeData,
        bool _hasSourceSwaps
    ) private {
        // Do CBridge stuff
        if (uint64(block.chainid) == _cBridgeData.dstChainId) revert CannotBridgeToSameNetwork();

        if (LibAsset.isNativeAsset(_cBridgeData.assetId)) {
            cBridge.sendNative{ value: _cBridgeData.amount }(
                _cBridgeData.receiver,
                _cBridgeData.amount,
                _cBridgeData.dstChainId,
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        } else {
            // Give CBridge approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_cBridgeData.assetId), address(cBridge), _cBridgeData.amount);
            // solhint-disable check-send-result
            cBridge.send(
                _cBridgeData.receiver,
                _cBridgeData.assetId,
                _cBridgeData.amount,
                _cBridgeData.dstChainId,
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "cbridge",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _cBridgeData.assetId,
            _lifiData.receivingAssetId,
            _cBridgeData.receiver,
            _cBridgeData.amount,
            _cBridgeData.dstChainId,
            _hasSourceSwaps,
            false
        );
    }
}
