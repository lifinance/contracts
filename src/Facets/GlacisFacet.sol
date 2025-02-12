// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IGlacisAirlift } from "../Interfaces/IGlacisAirlift.sol";

/// @title Glacis Facet
/// @author LI.FI (https://li.fi/)
/// @notice Integration of the Glacis airlift (wrapper for native token bridging standards)
/// @custom:version 1.0.0
contract GlacisFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @notice The contract address of the glacis airlift on the source chain.
    IGlacisAirlift public immutable airlift;

    /// Types ///

    /// @param refundAddress The address that would receive potential refunds on destination chain
    /// @param nativeFee The fee amount in native token required by the Glacis Airlift
    struct GlacisData {
        address refundAddress;
        uint256 nativeFee;
    }

    /// Constructor ///
    /// @notice Initializes the GlacisFacet contract
    /// @param _airlift The address of Glacis Airlift contract.
    constructor(IGlacisAirlift _airlift) {
        airlift = _airlift;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Glacis
    /// @param _bridgeData The core information needed for bridging
    /// @param _glacisData Data specific to Glacis
    function startBridgeTokensViaGlacis(
        ILiFi.BridgeData memory _bridgeData,
        GlacisData calldata _glacisData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _glacisData);
    }

    /// @notice Performs a swap before bridging via Glacis
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _glacisData Data specific to Glacis
    function swapAndStartBridgeTokensViaGlacis(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        GlacisData calldata _glacisData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _glacisData.nativeFee
        );
        _startBridge(_bridgeData, _glacisData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Glacis
    /// @param _bridgeData The core information needed for bridging
    /// @param _glacisData Data specific to Glacis
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        GlacisData calldata _glacisData
    ) internal {
        // Approve the Airlift contract to spend the required amount of tokens.
        // The `send` function assumes that the caller has already approved the token transfer,
        // ensuring that the cross-chain transaction and token transfer happen atomically.
        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(airlift),
            _bridgeData.minAmount
        );

        airlift.send{ value: _glacisData.nativeFee }(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            bytes32(uint256(uint160(_bridgeData.receiver))),
            _bridgeData.destinationChainId,
            _glacisData.refundAddress
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
