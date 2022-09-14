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
    /// Types ///

    struct WormholeData {
        address wormholeRouter;
        address token;
        uint256 amount;
        address recipient;
        uint16 toChainId;
        uint256 arbiterFee;
        uint32 nonce;
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
        _wormholeData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
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

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via Wormhole
    /// @param _wormholeData data specific to Wormhole
    function _startBridge(WormholeData memory _wormholeData) private {
        if (block.chainid == _wormholeData.toChainId) revert CannotBridgeToSameNetwork();
        LibAsset.maxApproveERC20(IERC20(_wormholeData.token), _wormholeData.wormholeRouter, _wormholeData.amount);
        IWormholeRouter(_wormholeData.wormholeRouter).transferTokens(
            _wormholeData.token,
            _wormholeData.amount,
            _wormholeData.toChainId,
            bytes32(uint256(uint160(_wormholeData.recipient))),
            _wormholeData.arbiterFee,
            _wormholeData.nonce
        );
    }
}
