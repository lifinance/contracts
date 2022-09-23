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
contract GenericSwapFacet is ILiFi, ReentrancyGuard, SwapperV2 {
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
    /// @param _swapData an array of swap related data for performing swaps before bridging
    function swapTokensGeneric(LiFiData calldata _lifiData, LibSwap.SwapData[] calldata _swapData)
        external
        payable
        nonReentrant
    {
        uint256 postSwapBalance = _executeAndCheckSwaps(_lifiData, _swapData, payable(msg.sender));
        address receivingAssetId = _swapData[_swapData.length - 1].receivingAssetId;
        LibAsset.transferAsset(receivingAssetId, payable(msg.sender), postSwapBalance);

        emit LiFiSwappedGeneric(
            _lifiData.transactionId,
            _lifiData.integrator,
            _lifiData.referrer,
            _swapData[0].sendingAssetId,
            receivingAssetId,
            _swapData[0].fromAmount,
            postSwapBalance
        );
    }
}
