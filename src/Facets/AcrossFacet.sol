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
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Across Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Across Protocol
contract AcrossFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Errors
    error QuoteTimeout();
    /// Types ///

    /// @param weth The contract address of the WETH token on the current chain.
    /// @param spokePool The contract address of the spoke pool on the source chain.
    /// @param destinationChainId The chainId of the chain to bridge to.
    /// @param relayerFeePct The relayer fee in token percentage with 18 decimals.
    /// @param quoteTimestamp The timestamp associated with the suggested fee.
    struct AcrossData {
        address weth;
        address spokePool;
        uint64 relayerFeePct;
        uint32 quoteTimestamp;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function startBridgeTokensViaAcross(ILiFi.BridgeData memory _bridgeData, AcrossData calldata _acrossData)
        external
        payable
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        nonReentrant
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _acrossData);
    }

    /// @notice Performs a swap before bridging via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _acrossData data specific to Across
    function swapAndStartBridgeTokensViaAcross(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        AcrossData memory _acrossData
    )
        external
        payable
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        validateBridgeData(_bridgeData)
        nonReentrant
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _acrossData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Across
    /// @param _bridgeData the core information needed for bridging
    /// @param _acrossData data specific to Across
    function _startBridge(ILiFi.BridgeData memory _bridgeData, AcrossData memory _acrossData) internal {
        if (_acrossData.quoteTimestamp > block.timestamp + 10 minutes) {
            revert QuoteTimeout();
        }
        bool isNative = _bridgeData.sendingAssetId == LibAsset.NATIVE_ASSETID;
        if (isNative) _bridgeData.sendingAssetId = _acrossData.weth;
        else LibAsset.maxApproveERC20(IERC20(_bridgeData.sendingAssetId), _acrossData.spokePool, _bridgeData.minAmount);

        IAcrossSpokePool pool = IAcrossSpokePool(_acrossData.spokePool);
        pool.deposit{ value: isNative ? _bridgeData.minAmount : 0 }(
            _bridgeData.receiver,
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            _bridgeData.destinationChainId,
            _acrossData.relayerFeePct,
            _acrossData.quoteTimestamp
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
