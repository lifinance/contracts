// SPDX-License-Identifier: MIT
pragma solidity ^0.8.7;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IThorSwap } from "../Interfaces/IThorSwap.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";

/// @title ThorSwap Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through ThorSwap
contract ThorSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    address private immutable thorchainRouter;

    /// @notice The struct for the ThorSwap data.
    /// @param vault The Thorchain vault address
    /// @param memo The memo to send to Thorchain for the swap
    /// @param expiration The expiration time for the swap
    struct ThorSwapData {
        address vault;
        string memo;
        uint256 expiration;
    }

    /// Errors ///
    error InvalidExpiration();

    /// @notice Initializes the ThorSwap contract
    constructor(address _thorchainRouter) {
        thorchainRouter = _thorchainRouter;
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _thorSwapData The ThorSwap data struct
    function startBridgeTokensViaThorSwap(
        ILiFi.BridgeData memory _bridgeData,
        ThorSwapData calldata _thorSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        // Check that expiration is at least 60 minutes from now
        if (_thorSwapData.expiration < block.timestamp + 60 minutes) {
            revert InvalidExpiration();
        }
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _thorSwapData);
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _swapData The swap data struct
    /// @param _thorSwapData The ThorSwap data struct
    function swapAndStartBridgeTokensViaThorSwap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        ThorSwapData calldata _thorSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        // Check that expiration is at least 60 minutes from now
        if (_thorSwapData.expiration < block.timestamp + 60 minutes) {
            revert InvalidExpiration();
        }
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _thorSwapData);
    }

    /// @notice Bridge tokens to another chain via ThorSwap
    /// @param _bridgeData The bridge data struct
    /// @param _thorSwapData The thorSwap data struct for ThorSwap specicific data
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        ThorSwapData calldata _thorSwapData
    ) internal {
        IERC20 sendingAssetId = IERC20(_bridgeData.sendingAssetId);
        bool isNative = LibAsset.isNativeAsset(address(sendingAssetId));

        if (!isNative) {
            LibAsset.maxApproveERC20(
                sendingAssetId,
                thorchainRouter,
                _bridgeData.minAmount
            );
        }
        IThorSwap(thorchainRouter).depositWithExpiry{
            value: isNative ? _bridgeData.minAmount : 0
        }(
            _thorSwapData.vault,
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            _thorSwapData.memo,
            _thorSwapData.expiration
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
