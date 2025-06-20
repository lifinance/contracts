// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title Pioneer Facet
/// @author LI.FI (https://li.fi)
/// @notice Main entry point to send bridge requests to Pioneer
/// @custom:version 1.1.0
contract PioneerFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// @notice Describes a refund address. Emitted after LiFiTransferStarted.
    /// @param refundTo If transaction failed, send inputs to this address.
    event RefundAddress(address refundTo);

    /// Storage ///

    address payable public immutable PIONEER_ADDRESS;

    /// @param refundAddress the address that is used for potential refunds
    struct PioneerData {
        address payable refundAddress;
    }

    /// Constructor ///

    constructor(address payable _pioneerAddress) {
        if (_pioneerAddress == address(0)) revert InvalidConfig();

        PIONEER_ADDRESS = _pioneerAddress;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Pioneer
    /// @param _bridgeData The core information needed for bridging
    function startBridgeTokensViaPioneer(
        ILiFi.BridgeData memory _bridgeData,
        PioneerData calldata _pioneerData
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
        _startBridge(_bridgeData, _pioneerData);
    }

    /// @notice Performs a swap before bridging via Pioneer
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    function swapAndStartBridgeTokensViaPioneer(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        PioneerData calldata _pioneerData
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
        _startBridge(_bridgeData, _pioneerData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Pioneer
    /// @param _bridgeData The core information needed for bridging
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        PioneerData calldata _pioneerData
    ) internal {
        LibAsset.transferAsset(
            _bridgeData.sendingAssetId,
            PIONEER_ADDRESS,
            _bridgeData.minAmount
        );

        emit LiFiTransferStarted(_bridgeData);
        emit RefundAddress(_pioneerData.refundAddress);
    }
}
