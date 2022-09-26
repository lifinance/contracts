// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IRootChainManager } from "../Interfaces/IRootChainManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Polygon Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Polygon Bridge
contract PolygonBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2 {
    /// Storage ///

    /// @notice The chain id of Polygon.
    uint64 private constant POLYGON_CHAIN_ID = 137;

    /// @notice The contract address of the RootChainManager on the source chain.
    IRootChainManager private immutable rootChainManager;

    /// @notice The contract address of the ERC20Predicate on the source chain.
    address private immutable erc20Predicate;

    /// Types ///

    /// @param assetId The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param receiver The address of the token receiver after bridging.
    struct BridgeData {
        address assetId;
        uint256 amount;
        address receiver;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _rootChainManager The contract address of the RootChainManager on the source chain.
    /// @param _erc20Predicate The contract address of the ERC20Predicate on the source chain.
    constructor(IRootChainManager _rootChainManager, address _erc20Predicate) {
        rootChainManager = _rootChainManager;
        erc20Predicate = _erc20Predicate;
    }

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
        address childToken;

        if (LibAsset.isNativeAsset(_bridgeData.assetId)) {
            rootChainManager.depositEtherFor{ value: _bridgeData.amount }(_bridgeData.receiver);
        } else {
            childToken = rootChainManager.rootToChildToken(_lifiData.sendingAssetId);

            LibAsset.maxApproveERC20(IERC20(_bridgeData.assetId), erc20Predicate, _bridgeData.amount);

            bytes memory depositData = abi.encode(_bridgeData.amount);
            rootChainManager.depositFor(_bridgeData.receiver, _bridgeData.assetId, depositData);
        }

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "polygon",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _bridgeData.assetId,
            childToken,
            _bridgeData.receiver,
            _bridgeData.amount,
            POLYGON_CHAIN_ID,
            _hasSourceSwap,
            false
        );
    }
}
