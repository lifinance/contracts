// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ICBridge } from "../Interfaces/ICBridge.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, CannotBridgeToSameNetwork, NativeValueWithERC, InvalidConfig } from "../Errors/GenericErrors.sol";
import { Swapper, LibSwap } from "../Helpers/Swapper.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title CBridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through CBridge
contract CBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///

    struct CBridgeData {
        address cBridge;
        uint32 maxSlippage;
        uint64 dstChainId;
        uint64 nonce;
        uint256 amount;
        address receiver;
        address token;
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
        LibAsset.depositAsset(_cBridgeData.token, _cBridgeData.amount);
        _startBridge(_cBridgeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "cbridge",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _cBridgeData.token,
            _lifiData.receivingAssetId,
            _cBridgeData.receiver,
            _cBridgeData.amount,
            _cBridgeData.dstChainId,
            false,
            false
        );
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
        _cBridgeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_cBridgeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "cbridge",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _cBridgeData.receiver,
            _swapData[0].fromAmount,
            _cBridgeData.dstChainId,
            true,
            false
        );
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via CBridge
    /// @param _cBridgeData data specific to CBridge
    function _startBridge(CBridgeData memory _cBridgeData) private {
        // Do CBridge stuff
        if (uint64(block.chainid) == _cBridgeData.dstChainId) revert CannotBridgeToSameNetwork();

        if (LibAsset.isNativeAsset(_cBridgeData.token)) {
            ICBridge(_cBridgeData.cBridge).sendNative{ value: _cBridgeData.amount }(
                _cBridgeData.receiver,
                _cBridgeData.amount,
                _cBridgeData.dstChainId,
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        } else {
            // Give CBridge approval to bridge tokens
            LibAsset.maxApproveERC20(IERC20(_cBridgeData.token), _cBridgeData.cBridge, _cBridgeData.amount);
            // solhint-disable check-send-result
            ICBridge(_cBridgeData.cBridge).send(
                _cBridgeData.receiver,
                _cBridgeData.token,
                _cBridgeData.amount,
                _cBridgeData.dstChainId,
                _cBridgeData.nonce,
                _cBridgeData.maxSlippage
            );
        }
    }
}
