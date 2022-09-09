// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IWormholeRouter } from "../Interfaces/IWormholeRouter.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, CannotBridgeToSameNetwork, InvalidConfig, UnsupportedChainId } from "../Errors/GenericErrors.sol";
import { Swapper } from "../Helpers/Swapper.sol";

/// @title Wormhole Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Wormhole
contract WormholeFacet is ILiFi, ReentrancyGuard, Swapper {

    /// Events ///
    event WormholeChainIdMapped(uint256 indexed lifiChainId, uint256 indexed wormholeChainId);

    /// Types ///
    struct WormholeData {
        address wormholeRouter;
        address token;
        uint256 amount;
        bytes32 recipient;
        uint16 toChainId;
        uint256 arbiterFee;
        uint32 nonce;
    }

    // Mapping between lifi chain id and wormhole chain id
    mapping (uint256 => uint256) public wormholeChainId;

    /// External Methods ///

    /// @notice Bridges tokens via Wormhole
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _wormholeData data specific to Wormhole
    function startBridgeTokensViaWormhole(LiFiData calldata _lifiData, WormholeData calldata _wormholeData)
        external
        payable
        nonReentrant
    {
        LibAsset.depositAsset(_wormholeData.token, _wormholeData.amount);
        _startBridge(_wormholeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "wormhole",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _wormholeData.token,
            _lifiData.receivingAssetId,
            _wormholeData.recipient,
            _wormholeData.amount,
            _wormholeData.toChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via Wormhole
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _wormholeData data specific to Wormhole
    function swapAndStartBridgeTokensViaWormhole(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        WormholeData memory _wormholeData
    ) external payable nonReentrant {
        _wormholeData.amount = _executeAndCheckSwaps(_lifiData, _swapData);
        _startBridge(_wormholeData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "wormhole",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _wormholeData.recipient,
            _swapData[0].fromAmount,
            _wormholeData.toChainId,
            true,
            false
        );
    }

    /// @notice Creates a mapping between a lifi chain id and a wormhole chain id
    /// @param _lifiChainId lifi chain id
    /// @param _wormholeChainId wormhole chain id
    function setWormholeChainId(uint256 _lifiChainId, uint256 _wormholeChainId) external {
        LibDiamond.enforceIsContractOwner();
        wormholeChainId[_lifiChainId] = _wormholeChainId;
        emit WormholeChainIdMapped(_lifiChainId, _wormholeChainId);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Wormhole
    /// @param _wormholeData data specific to Wormhole
    function _startBridge(WormholeData memory _wormholeData) private {

        uint256 fromChainId = block.chainid;
        uint256 toWormholeChainId = wormholeChainId[_wormholeData.toChainId];
        if (toWormholeChainId == 0) revert UnsupportedChainId(_wormholeData.toChainId);
        uint256 fromWormholeChainId = wormholeChainId[fromChainId];
        if (fromWormholeChainId == 0) revert UnsupportedChainId(fromChainId);
        if (fromWormholeChainId == toWormholeChainId) revert CannotBridgeToSameNetwork();

        LibAsset.maxApproveERC20(IERC20(_wormholeData.token), _wormholeData.wormholeRouter, _wormholeData.amount);
        IWormholeRouter(_wormholeData.wormholeRouter).transferTokens(
            _wormholeData.token,
            _wormholeData.amount,
            _wormholeData.toChainId,
            _wormholeData.recipient,
            _wormholeData.arbiterFee,
            _wormholeData.nonce
        );
    }
}
