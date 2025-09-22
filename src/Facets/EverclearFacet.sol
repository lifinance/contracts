// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Everclear Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Everclear
/// @custom:version 1.0.0
contract EverclearFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address public immutable FEE_ADAPTER;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param exampleParam Example parameter
    struct EverclearData {
      string feeAdapter;
    }

    /// Constructor ///

    /// @notice Constructor for the contract.
    /// @param _feeAdapter Fee adapter address.
    constructor(address _feeAdapter) {
        FEE_ADAPTER = _feeAdapter;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Everclear
    /// @param _bridgeData The core information needed for bridging
    /// @param _everclearData Data specific to Everclear
    function startBridgeTokensViaEverclear(
        ILiFi.BridgeData memory _bridgeData,
        EverclearData calldata _everclearData
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
        _startBridge(_bridgeData, _everclearData);
    }

    /// @notice Performs a swap before bridging via Everclear
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _everclearData Data specific to Everclear
    function swapAndStartBridgeTokensViaEverclear(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        EverclearData calldata _everclearData
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
        _startBridge(_bridgeData, _everclearData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Everclear
    /// @param _bridgeData The core information needed for bridging
    /// @param _everclearData Data specific to Everclear
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EverclearData calldata _everclearData
    ) internal {
        // TODO: Implement business logic
        // FEE_ADAPTER.newIntent(
        emit LiFiTransferStarted(_bridgeData);
    }
}
