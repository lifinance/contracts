// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IWormholeRouter } from "../Interfaces/IWormholeRouter.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidAmount, CannotBridgeToSameNetwork, InvalidConfig } from "../Errors/GenericErrors.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";

/// @title Wormhole Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Wormhole
contract WormholeFacet is ILiFi, ReentrancyGuard, SwapperV2 {
    /// Stargate ///

    /// @notice The contract address of the wormhole router on the source chain.
    IWormholeRouter private immutable router;

    /// Types ///

    /// @param assetId The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param receiver The address of the token receiver after bridging.
    /// @param toChainId The chainId of the chain to bridge to.
    /// @param arbiterFee The amount of token to pay a relayer (can be zero if no relayer is used).
    /// @param nonce A random nonce to associate with the tx.
    struct WormholeData {
        address assetId;
        uint256 amount;
        address receiver;
        uint16 toChainId;
        uint256 arbiterFee;
        uint32 nonce;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _router The contract address of the wormhole router on the source chain.
    constructor(IWormholeRouter _router) {
        router = _router;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Wormhole
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _wormholeData data specific to Wormhole
    function startBridgeTokensViaWormhole(LiFiData calldata _lifiData, WormholeData calldata _wormholeData)
        external
        payable
        nonReentrant
    {
        LibAsset.depositAsset(_wormholeData.assetId, _wormholeData.amount);
        _startBridge(_lifiData, _wormholeData, false);
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
        _wormholeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_lifiData, _wormholeData, true);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Wormhole
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _wormholeData data specific to Wormhole
    /// @param _hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        LiFiData calldata _lifiData,
        WormholeData memory _wormholeData,
        bool _hasSourceSwaps
    ) private {
        if (block.chainid == _wormholeData.toChainId) revert CannotBridgeToSameNetwork();
        LibAsset.maxApproveERC20(IERC20(_wormholeData.assetId), address(router), _wormholeData.amount);
        router.transferTokens(
            _wormholeData.assetId,
            _wormholeData.amount,
            _wormholeData.toChainId,
            bytes32(uint256(uint160(_wormholeData.receiver))),
            _wormholeData.arbiterFee,
            _wormholeData.nonce
        );
        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "wormhole",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _wormholeData.assetId,
            _lifiData.receivingAssetId,
            _wormholeData.receiver,
            _wormholeData.amount,
            _wormholeData.toChainId,
            _hasSourceSwaps,
            false
        );
    }
}
