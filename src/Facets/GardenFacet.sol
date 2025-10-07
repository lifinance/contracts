// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGarden, IGardenRegistry } from "../Interfaces/IGarden.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidConfig, InvalidReceiver } from "../Errors/GenericErrors.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";

/// @title Garden Facet
/// @author LI.FI (https://li.fi)
/// @notice Bridge assets via Garden protocol
/// @custom:version 1.0.0
contract GardenFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    /// @dev Immutable registry address
    IGardenRegistry private immutable REGISTRY;

    /// @dev Garden's standard address for native token HTLCs
    address private constant NATIVE_TOKEN_ADDRESS =
        0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// Constructor ///

    /// @notice Constructor initializes the immutable registry
    /// @param _htlcRegistry Address of the HTLC registry contract
    constructor(address _htlcRegistry) {
        if (_htlcRegistry == address(0)) revert InvalidConfig();
        REGISTRY = IGardenRegistry(_htlcRegistry);
    }

    /// Types ///

    /// @param redeemer Address that will receive the funds (solver/filler address on source chain)
    /// @param refundAddress Address that can claim refund on source chain if HTLC expires
    /// @param timelock Number of blocks after which refund is possible (relative to current block)
    /// @param secretHash SHA256 hash of the secret for the HTLC
    /// @param nonEvmReceiver Address of the receiver on non-EVM destination chains (e.g., Bitcoin)
    /// @dev Note: Transfer details (destination chain, receiver) are encoded in an off-chain order.
    ///      There is no on-chain guarantee that emitted params match the actual transfer details.
    struct GardenData {
        address redeemer;
        address refundAddress;
        uint256 timelock;
        bytes32 secretHash;
        bytes32 nonEvmReceiver;
    }

    /// Errors ///

    /// @notice Thrown when attempting to bridge an unsupported asset
    error AssetNotSupported();
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
    /// @param _gardenData Data specific to Garden (redeemer is the solver/filler who will receive the funds)
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        GardenData calldata _gardenData
    ) internal {
        // Validate Garden-specific parameters
        // Note: timelock represents the number of blocks after which refund is possible
        if (
            _gardenData.redeemer == address(0) ||
            _gardenData.timelock == 0 ||
            _gardenData.secretHash == bytes32(0)
        ) revert InvalidGardenData();

        // Validate refund address
        if (_gardenData.refundAddress == address(0)) {
            revert InvalidReceiver();
        }

        // Get HTLC address from registry
        // For native assets, use Garden's standard native token address
        address assetForGarden = LibAsset.isNativeAsset(
            _bridgeData.sendingAssetId
        )
            ? NATIVE_TOKEN_ADDRESS
            : _bridgeData.sendingAssetId;
        address htlcAddress = REGISTRY.htlcs(assetForGarden);

        // Validate asset is supported
        if (htlcAddress == address(0)) {
            revert AssetNotSupported();
        }

        // Get the Garden HTLC contract instance
        IGarden garden = IGarden(htlcAddress);

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Native token bridging - send value with the call
            garden.initiateOnBehalf{ value: _bridgeData.minAmount }(
                _gardenData.refundAddress,
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
                _gardenData.refundAddress,
                _gardenData.redeemer,
                _gardenData.timelock,
                _bridgeData.minAmount,
                _gardenData.secretHash
            );
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _gardenData.nonEvmReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
