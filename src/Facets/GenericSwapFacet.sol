// SPDX-License-Identifier: MIT
pragma solidity 0.8.13;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { ZeroPostSwapBalance } from "../Errors/GenericErrors.sol";
import { Swapper, LibSwap } from "../Helpers/Swapper.sol";

/// @title Generic Swap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for swapping through ANY APPROVED DEX
/// @dev Uses calldata to execute APPROVED arbitrary methods on DEXs
contract GenericSwapFacet is ILiFi, Swapper, ReentrancyGuard {
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
        uint256 postSwapBalance = _executeAndCheckSwaps(_lifiData, _swapData);
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
