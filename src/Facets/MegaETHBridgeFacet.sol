// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IL1StandardBridge } from "../Interfaces/IL1StandardBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidConfig, AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title MegaETH Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through MegaETH Bridge
/// @custom:version 1.0.0
contract MegaETHBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.megaeth");

    /// Types ///

    struct Storage {
        mapping(address => IL1StandardBridge) bridges;
        IL1StandardBridge standardBridge;
        bool initialized;
    }

    struct Config {
        address assetId;
        address bridge;
    }

    struct MegaETHData {
        address assetIdOnL2;
        uint32 l2Gas;
        bool isSynthetix;
    }

    /// Events ///

    event MegaETHInitialized(Config[] configs);
    event MegaETHBridgeRegistered(address indexed assetId, address bridge);

    /// Init ///

    /// @notice Initialize local variables for the MegaETH Bridge Facet
    /// @param configs Bridge configuration data
    function initMegaETH(
        Config[] calldata configs,
        IL1StandardBridge standardBridge
    ) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (s.initialized) {
            revert AlreadyInitialized();
        }

        for (uint256 i = 0; i < configs.length; i++) {
            if (configs[i].bridge == address(0)) {
                revert InvalidConfig();
            }
            s.bridges[configs[i].assetId] = IL1StandardBridge(
                configs[i].bridge
            );
        }

        s.standardBridge = standardBridge;
        s.initialized = true;

        emit MegaETHInitialized(configs);
    }

    /// External Methods ///

    /// @notice Register token and bridge
    /// @param assetId Address of token
    /// @param bridge Address of bridge for asset
    function registerMegaETHBridge(address assetId, address bridge) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (!s.initialized) revert NotInitialized();

        if (bridge == address(0)) {
            revert InvalidConfig();
        }

        s.bridges[assetId] = IL1StandardBridge(bridge);

        emit MegaETHBridgeRegistered(assetId, bridge);
    }

    /// @notice Bridges tokens via MegaETH Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _bridgeData Data specific to MegaETH Bridge
    function startBridgeTokensViaMegaETHBridge(
        ILiFi.BridgeData memory _bridgeData,
        MegaETHData calldata _megaETHData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _megaETHData);
    }

    /// @notice Performs a swap before bridging via MegaETH Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to MegaETH Bridge
    function swapAndStartBridgeTokensViaMegaETHBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        MegaETHData calldata _megaETHData
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
        _startBridge(_bridgeData, _megaETHData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via MegaETH Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _bridgeData Data specific to MegaETH Bridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        MegaETHData calldata _megaETHData
    ) private {
        Storage storage s = getStorage();
        IL1StandardBridge nonStandardBridge = s.bridges[
            _bridgeData.sendingAssetId
        ];
        IL1StandardBridge bridge = LibUtil.isZeroAddress(
            address(nonStandardBridge)
        )
            ? s.standardBridge
            : nonStandardBridge;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            bridge.depositETHTo{ value: _bridgeData.minAmount }(
                _bridgeData.receiver,
                _megaETHData.l2Gas,
                ""
            );
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(bridge),
                _bridgeData.minAmount
            );

            if (_megaETHData.isSynthetix) {
                bridge.depositTo(_bridgeData.receiver, _bridgeData.minAmount);
            } else {
                bridge.depositERC20To(
                    _bridgeData.sendingAssetId,
                    _megaETHData.assetIdOnL2,
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    _megaETHData.l2Gas,
                    ""
                );
            }
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
