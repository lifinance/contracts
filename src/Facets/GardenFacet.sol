// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGarden, IGardenRegistry } from "../Interfaces/IGarden.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Garden Facet
/// @author LI.FI (https://li.fi)
/// @notice Bridge assets via Garden protocol
/// @custom:version 1.0.0
contract GardenFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    /// @dev Immutable registry address
    IGardenRegistry private immutable REGISTRY;

    /// Constructor ///

    /// @notice Constructor initializes the immutable registry
    /// @param _htlcRegistry Address of the HTLC registry contract
    constructor(address _htlcRegistry) {
        if (_htlcRegistry == address(0)) revert InvalidRegistry();
        REGISTRY = IGardenRegistry(_htlcRegistry);
    }

    /// Types ///

    /// @param redeemer Address authorized to redeem the HTLC
    /// @param timelock Block number after which refund is possible
    /// @param secretHash SHA256 hash of the secret for the HTLC
    struct GardenData {
        address redeemer;
        uint256 timelock;
        bytes32 secretHash;
    }

    /// Errors ///

    /// @notice Thrown when attempting to bridge an unsupported asset
    error AssetNotSupported();
    /// @notice Thrown when the registry address is invalid
    error InvalidRegistry();
    /// @notice Thrown when Garden parameters are invalid
    error InvalidGardenData();

    /// External Methods ///

    /// @notice Bridges tokens via Garden
    /// @param _bridgeData The core information needed for bridging
    /// @param _gardenData Data specific to Garden
    function startBridgeTokensViaGarden(
        ILiFi.BridgeData memory _bridgeData,
        GardenData calldata _gardenData
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
        _startBridge(_bridgeData, _gardenData);
    }

    /// @notice Performs a swap before bridging via Garden
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _gardenData Data specific to Garden
    function swapAndStartBridgeTokensViaGarden(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        GardenData calldata _gardenData
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
        _startBridge(_bridgeData, _gardenData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via Garden
    /// @param _bridgeData The core information needed for bridging
    /// @param _gardenData Data specific to Garden
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        GardenData calldata _gardenData
    ) internal {
        // Validate Garden-specific parameters
        if (
            _gardenData.redeemer == address(0) ||
            _gardenData.timelock <= block.number ||
            _gardenData.secretHash == bytes32(0)
        ) revert InvalidGardenData();

        // Determine the asset key - use NULL_ADDRESS for native assets
        address assetKey = LibAsset.isNativeAsset(_bridgeData.sendingAssetId)
            ? LibAsset.NULL_ADDRESS
            : _bridgeData.sendingAssetId;

        // Get HTLC address from registry
        address htlcAddress = REGISTRY.htlcs(assetKey);

        // Validate asset is supported
        if (htlcAddress == address(0)) {
            revert AssetNotSupported();
        }

        // Get the Garden HTLC contract instance
        IGarden garden = IGarden(htlcAddress);

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Native token bridging - send value with the call
            garden.initiateOnBehalf{ value: _bridgeData.minAmount }(
                _bridgeData.receiver,
                _gardenData.redeemer,
                _gardenData.timelock,
                _bridgeData.minAmount,
                _gardenData.secretHash
            );
        } else {
            // ERC20 token bridging - approve and call with 0 value
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                htlcAddress,
                _bridgeData.minAmount
            );

            garden.initiateOnBehalf(
                _bridgeData.receiver,
                _gardenData.redeemer,
                _gardenData.timelock,
                _bridgeData.minAmount,
                _gardenData.secretHash
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
