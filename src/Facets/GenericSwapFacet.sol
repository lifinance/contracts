// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Generic Swap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for swapping through ANY APPROVED DEX
/// @dev Uses calldata to execute APPROVED arbitrary methods on DEXs
contract GenericSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Events ///

    event LiFiSwappedGeneric(
        bytes32 indexed transactionId,
        string integrator,
        string referrer,
        address fromAssetId,
        address toAssetId,
        uint256 fromAmount,
        uint256 toAmount
    );

    /// External Methods ///

    /// @notice Performs multiple swaps in one transaction
    /// @param _transactionId the transaction id associated with the operation
    /// @param _integrator the name of the integrator
    /// @param _referrer the address of the referrer
    /// @param _minAmount the minimum amount of the final asset to receive
    /// @param _swapData an object containing swap related data to perform swaps before bridging
    function swapTokensGeneric(
        bytes32 _transactionId,
        string calldata _integrator,
        string calldata _referrer,
        uint256 _minAmount,
        LibSwap.SwapData[] calldata _swapData
    ) external payable refundExcessNative(payable(msg.sender)) nonReentrant {
        uint256 postSwapBalance = _depositAndSwap(_transactionId, _minAmount, _swapData, payable(msg.sender));
        address receivingAssetId = _swapData[_swapData.length - 1].receivingAssetId;
        LibAsset.transferAsset(receivingAssetId, payable(msg.sender), postSwapBalance);

        emit LiFiSwappedGeneric(
            _transactionId,
            _integrator,
            _referrer,
            _swapData[0].sendingAssetId,
            receivingAssetId,
            _swapData[0].fromAmount,
            postSwapBalance
        );
    }
}
