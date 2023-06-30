// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Foobar Facet
/// @author LI.FI (https://li.fi)
/// @notice sdfdsafsdfsdf
/// @custom:version 1.0.0
contract FoobarFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    address public immutable example;

    /// Types ///

    /// @param exampleParam Example paramter
    struct FoobarData {
        string exampleParam;
    }

    /// Constructor ///

    /// @notice Initialize the contract.
    /// @param _example Example paramter.
    constructor(address _example) {
        example = _example;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Foobar
    /// @param _bridgeData The core information needed for bridging
    /// @param _foobarData Data specific to Foobar
    function startBridgeTokensViaFoobar(
        ILiFi.BridgeData memory _bridgeData,
        FoobarData calldata _foobarData
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
        _startBridge(_bridgeData, _foobarData);
    }

    /// @notice Performs a swap before bridging via Foobar
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _foobarData Data specific to Foobar
    function swapAndStartBridgeTokensViaFoobar(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        FoobarData calldata _foobarData
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
        _startBridge(_bridgeData, _foobarData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Foobar
    /// @param _bridgeData The core information needed for bridging
    /// @param _foobarData Data specific to Foobar
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        FoobarData calldata _foobarData
    ) internal {
        // TODO: Implement business logic
        emit LiFiTransferStarted(_bridgeData);
    }
}
