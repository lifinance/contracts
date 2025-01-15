// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGlacisAirlift } from "../Interfaces/IGlacisAirlift.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { ERC20, SafeTransferLib } from "solmate/utils/SafeTransferLib.sol";

/// @title Glacis Facet
/// @author LI.FI (https://li.fi)
/// @notice Integrates Glacis Airlift (a wrapper for various native token bridging standards)
/// @custom:version 1.0.0
contract GlacisFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    using SafeTransferLib for ERC20;
    /// Storage ///

    IGlacisAirlift public immutable glacisAirlift;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param refundAddress The address that should receive potential refunds
    struct GlacisData {
        address refundAddress;
    }

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _glacisAirlift the address of the GlacisAirlift diamond contract
    constructor(address _glacisAirlift) {
        glacisAirlift = IGlacisAirlift(_glacisAirlift);
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
            payable(msg.sender)
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
        // forward the tokens to the glacis contract
        ERC20(_bridgeData.sendingAssetId).transfer(
            address(glacisAirlift),
            _bridgeData.minAmount
        );

        // call the glacis airlift send function to make a deposit
        glacisAirlift.send(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount,
            bytes32(uint256(uint160(_bridgeData.receiver))),
            _bridgeData.destinationChainId,
            _glacisData.refundAddress
        );

        emit LiFiTransferStarted(_bridgeData);
    }
}
