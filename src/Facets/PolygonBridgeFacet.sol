// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IRootChainManager } from "../Interfaces/IRootChainManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Polygon Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Polygon Bridge
contract PolygonBridgeFacet is ILiFi, SwapperV2, ReentrancyGuard, Validatable {
    uint64 internal constant POLYGON_CHAIN_ID = 137;

    /// Types ///

    struct PolygonData {
        address rootChainManager;
        address erc20Predicate;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Polygon Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _polygonData Data for asset id and amount
    function startBridgeTokensViaPolygonBridge(ILiFi.BridgeData memory _bridgeData, PolygonData calldata _polygonData)
        external
        payable
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _polygonData, false);
    }

    /// @notice Performs a swap before bridging via Polygon Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _polygonData Data for asset id and amount
    function swapAndStartBridgeTokensViaPolygonBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        PolygonData calldata _polygonData
    ) external payable validateBridgeData(_bridgeData) nonReentrant {
        LibAsset.depositAssets(_swapData);
        _bridgeData.minAmount = _executeAndCheckSwaps(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _polygonData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Polygon Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _polygonData Parameters used for bridging
    /// @param _hasSourceSwap Did swap on sending chain
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        PolygonData calldata _polygonData,
        bool _hasSourceSwap
    ) private {
        IRootChainManager rootChainManager = IRootChainManager(_polygonData.rootChainManager);
        address childToken;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            rootChainManager.depositEtherFor{ value: _bridgeData.minAmount }(_bridgeData.receiver);
        } else {
            childToken = rootChainManager.rootToChildToken(_bridgeData.sendingAssetId);

            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                _polygonData.erc20Predicate,
                _bridgeData.minAmount
            );

            bytes memory depositData = abi.encode(_bridgeData.minAmount);
            rootChainManager.depositFor(_bridgeData.receiver, _bridgeData.sendingAssetId, depositData);
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
