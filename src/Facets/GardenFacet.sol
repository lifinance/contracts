// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IGarden } from "../Interfaces/IGarden.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
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

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.garden");

    /// @dev Asset type enumeration
    enum AssetType {
        NATIVE,
        ERC20
    }

    /// @dev Storage for Garden configuration
    struct Storage {
        mapping(address => AssetConfig) assetConfigs; // token address => HTLC config
    }

    /// @dev Configuration for each supported asset
    struct AssetConfig {
        address htlcAddress; // HTLC contract address for this asset
        AssetType assetType; // Whether asset is NATIVE or ERC20
        bool isActive; // Whether this asset is currently supported
    }

    /// Types ///

    /// @param timelock Block number after which refund is possible
    /// @param secretHash SHA256 hash of the secret for the HTLC
    struct GardenData {
        uint256 timelock;
        bytes32 secretHash;
    }

    /// Events ///

    event GardenInitialized();

    /// Errors ///

    /// @notice Thrown when attempting to bridge an unsupported asset
    error AssetNotSupported();

    /// @notice Thrown when an invalid configuration is provided
    error InvalidGardenConfig();

    /// Init ///

    /// @dev Configuration structure for initializing assets
    struct InitConfig {
        address assetAddress; // Token address (use address(0) for native)
        address htlcAddress; // HTLC contract for this asset
        AssetType assetType; // NATIVE or ERC20
    }

    /// @notice Initialize Garden facet with supported assets
    /// @param configs Array of asset configurations
    function initGarden(InitConfig[] calldata configs) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        for (uint256 i = 0; i < configs.length; i++) {
            // Validate configuration
            if (configs[i].htlcAddress == address(0)) {
                revert InvalidGardenConfig();
            }

            // For native assets, ensure assetAddress is NULL_ADDRESS
            if (
                configs[i].assetType == AssetType.NATIVE &&
                configs[i].assetAddress != LibAsset.NULL_ADDRESS
            ) {
                revert InvalidGardenConfig();
            }

            // Store configuration
            s.assetConfigs[configs[i].assetAddress] = AssetConfig({
                htlcAddress: configs[i].htlcAddress,
                assetType: configs[i].assetType,
                isActive: true
            });
        }

        emit GardenInitialized();
    }

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
        Storage storage s = getStorage();

        // Determine the mapping key - use NULL_ADDRESS for native assets
        address assetKey = LibAsset.isNativeAsset(_bridgeData.sendingAssetId)
            ? LibAsset.NULL_ADDRESS
            : _bridgeData.sendingAssetId;

        // Get asset configuration
        AssetConfig memory config = s.assetConfigs[assetKey];

        // Validate asset is supported
        if (!config.isActive || config.htlcAddress == address(0)) {
            revert AssetNotSupported();
        }

        // Get the Garden HTLC contract instance
        IGarden garden = IGarden(config.htlcAddress);

        if (config.assetType == AssetType.NATIVE) {
            // Native token bridging - send value with the call
            garden.initiateOnBehalf{ value: _bridgeData.minAmount }(
                address(this), // initiator is always the Diamond
                _bridgeData.receiver, // redeemer from bridge data
                _gardenData.timelock,
                _bridgeData.minAmount,
                _gardenData.secretHash
            );
        } else {
            // ERC20 token bridging - approve and call with 0 value
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                config.htlcAddress,
                _bridgeData.minAmount
            );

            garden.initiateOnBehalf{ value: 0 }(
                address(this), // initiator is always the Diamond
                _bridgeData.receiver, // redeemer from bridge data
                _gardenData.timelock,
                _bridgeData.minAmount,
                _gardenData.secretHash
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @dev fetch local storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
