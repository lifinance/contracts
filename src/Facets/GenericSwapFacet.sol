// SPDX-License-Identifier: MIT
pragma solidity 0.8.16;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";

/// @title Generic Swap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for swapping through ANY APPROVED DEX
/// @dev Uses calldata to execute APPROVED arbitrary methods on DEXs
contract GenericSwapFacet is ILiFi, SwapperV2, ReentrancyGuard {
    /// Events ///

    event LiFiSwappedGeneric(
        bytes32 indexed transactionId,
        string integrator,
        address referrer,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount
    );

    /// External Methods ///

    /// @notice Performs multiple swaps in one transaction
    /// @param _lifiData data used purely for tracking and analytics
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensGeneric(LiFiData calldata _lifiData, LibSwap.SwapData calldata _swapData)
        external
        payable
        nonReentrant
    {
        uint256 postSwapBalance = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        LibSwap.Swap[] calldata swaps = _swapData.swaps;
        address receivingAssetId = swaps[swaps.length - 1].receivingAssetId;
        LibAsset.transferAsset(receivingAssetId, payable(msg.sender), postSwapBalance);

        emit LiFiSwappedGeneric(
            _lifiData.transactionId,
            _lifiData.integrator,
            _lifiData.referrer,
            swaps[0].sendingAssetId,
            receivingAssetId,
            swaps[0].fromAmount,
            postSwapBalance
        );
    }
}
