// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IAcrossSpokePool } from "../Interfaces/IAcrossSpokePool.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";

/// @title Across Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across Protocol
contract AcrossFacet is ILiFi, ReentrancyGuard, SwapperV2 {
    /// Types ///

    struct AcrossData {
        address weth;
        address spokePool;
        address recipient;
        address token;
        uint256 amount;
        uint256 destinationChainId;
        uint64 relayerFeePct;
        uint32 quoteTimestamp;
    }

    /// Errors ///

    error UseWethInstead();

    /// External Methods ///

    /// @notice Bridges tokens via Across
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _acrossData data specific to Across
    function startBridgeTokensViaAcross(LiFiData memory _lifiData, AcrossData calldata _acrossData)
        external
        payable
        nonReentrant
    {
        LibAsset.depositAsset(_acrossData.token, _acrossData.amount);
        _startBridge(_acrossData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "across",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _acrossData.token,
            _lifiData.receivingAssetId,
            _acrossData.recipient,
            _acrossData.amount,
            _lifiData.destinationChainId,
            false,
            false
        );
    }

    /// @notice Performs a swap before bridging via Across
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _acrossData data specific to Across
    function swapAndStartBridgeTokensViaAcross(
        LiFiData calldata _lifiData,
        LibSwap.SwapData[] calldata _swapData,
        AcrossData memory _acrossData
    ) external payable nonReentrant {
        _acrossData.amount = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        _startBridge(_acrossData);

        emit LiFiTransferStarted(
            _lifiData.transactionId,
            "across",
            "",
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            _lifiData.receivingAssetId,
            _acrossData.recipient,
            _swapData[0].fromAmount,
            _lifiData.destinationChainId,
            true,
            false
        );
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Across
    /// @param _acrossData data specific to Across
    function _startBridge(AcrossData memory _acrossData) internal {
        bool isNative = _acrossData.token == LibAsset.NATIVE_ASSETID;
        if (isNative) _acrossData.token = _acrossData.weth;
        else LibAsset.maxApproveERC20(IERC20(_acrossData.token), _acrossData.spokePool, _acrossData.amount);
        IAcrossSpokePool pool = IAcrossSpokePool(_acrossData.spokePool);
        pool.deposit{ value: isNative ? _acrossData.amount : 0 }(
            _acrossData.recipient,
            _acrossData.token,
            _acrossData.amount,
            _acrossData.destinationChainId,
            _acrossData.relayerFeePct,
            _acrossData.quoteTimestamp
        );
    }
}
