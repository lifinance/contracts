// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IRootChainManager } from "../Interfaces/IRootChainManager.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

//! applied measures to save gas (not exhaustive):
//! - removed unnecessary validity checks => ca. 200 gas saved
//! - replaced Library calls by internal (reduced) code
//!     - replaced LibAsset.depositAsset(..) => ca. 1500 gas saved
//! - if we remove nonReentrant modifier => ca. 23000 gas saved (!!!!!!!!)

/// @title Polygon Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through Polygon Bridge
contract PolygonBridgeFacetOptimized is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The chain id of Polygon.
    uint64 private constant POLYGON_CHAIN_ID = 137;

    /// @notice The contract address of the RootChainManager on the source chain.
    IRootChainManager private immutable rootChainManager;

    /// @notice The contract address of the ERC20Predicate on the source chain.
    address private immutable erc20Predicate;

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
    /// @param _bridgeData Data containing core information for bridging
    function startBridgeTokensViaPolygonBridge(ILiFi.BridgeData memory _bridgeData)
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
    {
        // LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        IERC20 asset = IERC20(_bridgeData.sendingAssetId);
        uint256 prevBalance = asset.balanceOf(address(this));
        SafeERC20.safeTransferFrom(asset, msg.sender, address(this), _bridgeData.minAmount);
        if (asset.balanceOf(address(this)) - prevBalance != _bridgeData.minAmount) revert InvalidAmount(); //! required for to exclude tokens that take fees
        _startBridge(_bridgeData);
    }

    /// @notice Performs a swap before bridging via Polygon Bridge
    /// @param _bridgeData Data containing core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaPolygonBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData
    ) external payable nonReentrant refundExcessNative(payable(msg.sender)) {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Polygon Bridge
    /// @param _bridgeData Data containing core information for bridging
    function _startBridge(ILiFi.BridgeData memory _bridgeData) private {
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            rootChainManager.depositEtherFor{ value: _bridgeData.minAmount }(_bridgeData.receiver);
        } else {
            rootChainManager.rootToChildToken(_bridgeData.sendingAssetId);

            // get max approval
            uint256 allowance = IERC20(_bridgeData.sendingAssetId).allowance(address(this), erc20Predicate);
            if (allowance < _bridgeData.minAmount)
                SafeERC20.safeIncreaseAllowance(
                    IERC20(_bridgeData.sendingAssetId),
                    erc20Predicate,
                    type(uint256).max - allowance
                );

            rootChainManager.depositFor(
                _bridgeData.receiver,
                _bridgeData.sendingAssetId,
                abi.encode(_bridgeData.minAmount)
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
