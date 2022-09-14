// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IRootChainManager } from "../Interfaces/IRootChainManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Polygon Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Polygon Bridge
contract PolygonBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Types ///

    struct BridgeData {
        address rootChainManager;
        address erc20Predicate;
        address assetId;
        address receiver;
        uint256 amount;
    }

    /// Errors ///

    error InvalidConfig();
    error InvalidReceiver();

    /// External Methods ///

    /// @notice Bridges tokens via Polygon Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Data for asset id and amount
    function startBridgeTokensViaPolygonBridge(LiFiData calldata _lifiData, BridgeData calldata _bridgeData)
        external
        payable
        nonReentrant
    {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }

        LibAsset.depositAsset(_bridgeData.assetId, _bridgeData.amount);

        _startBridge(_lifiData, _bridgeData, false);
    }

    /// @notice Performs a swap before bridging via Polygon Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data for asset id and amount
    function swapAndStartBridgeTokensViaPolygonBridge(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        BridgeData memory _bridgeData
    ) external payable nonReentrant {
        if (_bridgeData.receiver == address(0)) {
            revert InvalidReceiver();
        }
        _bridgeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _bridgeData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Polygon Bridge
    /// @param _lifiData Data used purely for tracking and analytics
    /// @param _bridgeData Parameters used for bridging
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        LiFiData calldata _lifiData,
        BridgeData memory _bridgeData,
        bool _hasSourceSwap
    ) private {
        IRootChainManager rootChainManager = IRootChainManager(_bridgeData.rootChainManager);
        address childToken;

        if (LibAsset.isNativeAsset(_bridgeData.assetId)) {
            rootChainManager.depositEtherFor{ value: _bridgeData.amount }(_bridgeData.receiver);
        } else {
            childToken = rootChainManager.rootToChildToken(_lifiData.sendingAssetId);

            LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), _bridgeData.erc20Predicate, _bridgeData.amount);

            bytes memory depositData = abi.encode(_bridgeData.amount);
            rootChainManager.depositFor(_bridgeData.receiver, _bridgeData.assetId, depositData);
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "polygon",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _lifiData.sendingAssetId,
            childToken,
            _lifiData.receiver,
            _lifiData.amount,
            _lifiData.destinationChainId,
            _hasSourceSwap,
            false
        );
    }
}
