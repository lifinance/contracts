// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

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

    /// @param weth The contract address of the WETH token on the current chain.
    /// @param spokePool The contract address of the spoke pool on the source chain.
    /// @param recipient The address of the token recipient after bridging.
    /// @param token The contract address of the token being bridged.
    /// @param amount The amount of tokens to bridge.
    /// @param destinationChainId The chainId of the chain to bridge to.
    /// @param relayerFeePct The relayer fee in token percentage with 18 decimals.
    /// @param quoteTimestamp The timestamp associated with the suggested fee.
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

    /// External Methods ///

    /// @notice Bridges tokens via Across
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _acrossData data specific to Across
    function startBridgeTokensViaAcross(LiFiData calldata _lifiData, AcrossData calldata _acrossData)
        external
        payable
        nonReentrant
    {
        LibAsset.depositAsset(_acrossData.token, _acrossData.amount);
        _startBridge(_lifiData, _acrossData, false);
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
        _startBridge(_lifiData, _acrossData, true);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Across
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _acrossData data specific to Across
    /// @param _hasSourceSwaps whether or not the bridge has source swaps
    function _startBridge(
        LiFiData calldata _lifiData,
        AcrossData memory _acrossData,
        bool _hasSourceSwaps
    ) internal {
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
            _acrossData.destinationChainId,
            _hasSourceSwaps,
            false
        );
    }
}
