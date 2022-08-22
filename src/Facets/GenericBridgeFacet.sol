// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { InvalidAmount } from "../Errors/GenericErrors.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";

/// @title Generic Bridge Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through ANY Bridge
/// @dev Uses calldata to execute arbitrary methods on bridges
contract GenericBridgeFacet is ILiFi, ReentrancyGuard {
    /// Types ///

    struct BridgeData {
        uint256 amount;
        address assetId;
        address callTo;
        bytes callData;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Generic Bridge
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _bridgeData data used for bridging via various contracts
    function startBridgeTokensGeneric(LiFiData calldata _lifiData, BridgeData calldata _bridgeData)
        external
        payable
        nonReentrant
    {
        address sendingAssetId = _bridgeData.assetId;

        if (sendingAssetId == address(0)) {
            if (msg.value != _bridgeData.amount) revert InvalidAmount();
        } else {
            uint256 _sendingAssetIdBalance = LibAsset.getOwnBalance(sendingAssetId);
            LibAsset.transferFromERC20(sendingAssetId, msg.sender, address(this), _bridgeData.amount);
            if (LibAsset.getOwnBalance(sendingAssetId) - _sendingAssetIdBalance != _bridgeData.amount)
                revert InvalidAmount();
        }

        _startBridge(_bridgeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "generic",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            _lifiData.receivingAssetId,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _bridgeData data used for bridging via various contracts
    function swapAndStartBridgeTokensGeneric(
        LiFiData memory _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData memory _bridgeData
    ) external payable nonReentrant {
        address sendingAssetId = _bridgeData.assetId;
        uint256 _sendingAssetIdBalance = LibAsset.getOwnBalance(sendingAssetId);

        // Swap
        for (uint8 i = 0; i < _swapData.length; i++) {
            LibSwap.swap(_lifiData.transactionId, _swapData[i]);
        }

        uint256 _postSwapBalance = LibAsset.getOwnBalance(sendingAssetId) - _sendingAssetIdBalance;

        if (_postSwapBalance == 0) revert InvalidAmount();

        _bridgeData.amount = _postSwapBalance;

        _startBridge(_bridgeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "generic",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            _lifiData.receivingAssetId,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            true,
            false
        );
    }

    /// Internal Methods ///

    /// @dev Conatains the business logic for the bridge
    /// @param _bridgeData data used for bridging via various contracts
    function _startBridge(BridgeData memory _bridgeData) internal {
        LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.callTo, _bridgeData.amount);

        uint256 value = LibAsset.isNativeAsset(address(_bridgeData.assetId)) ? _bridgeData.amount : 0;
        // solhint-disable avoid-low-level-calls
        (bool success, bytes memory res) = _bridgeData.callTo.call{ value: value }(_bridgeData.callData);
        if (!success) {
            string memory reason = LibUtil.getRevertMsg(res);
            revert(reason);
        }
    }
}
