// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IL1StandardBridge } from "../Interfaces/IL1StandardBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { InvalidConfig, AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";

/// @title OpBNB Bridge Facet
/// @author Li.Finance (https://li.finance)
/// @notice Provides functionality for bridging through OpBNB Bridge
/// @custom:version 1.0.0
contract OpBNBBridgeFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.opbnb");

    /// Types ///

    struct Storage {
        mapping(address => IL1StandardBridge) bridges;
        IL1StandardBridge standardBridge;
    }

    // @notice OpBNB Config
    // @notice some assets but not all require a non-standard bridge
    // @param assetId Address of token
    // @param bridge Address of non-standard bridge for asset
    struct Config {
        address assetId;
        address bridge;
    }

    struct OpBNBData {
        address assetIdOnL2;
        uint32 l2Gas;
        bool isSynthetix;
    }

    /// Events ///

    event OptimismInitialized(Config[] configs);
    event OptimismBridgeRegistered(address indexed assetId, address bridge);

    /// Init ///

    /// @notice Initialize local variables for the OpBNB Bridge Facet
    /// @param configs Bridge configuration data
    function initOpBNB(
        Config[] calldata configs,
        IL1StandardBridge standardBridge
    ) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        for (uint256 i = 0; i < configs.length; i++) {
            if (configs[i].bridge == address(0)) {
                revert InvalidConfig();
            }
            s.bridges[configs[i].assetId] = IL1StandardBridge(
                configs[i].bridge
            );
        }

        s.standardBridge = standardBridge;

        emit OptimismInitialized(configs);
    }

    /// External Methods ///

    /// @notice Register token and bridge
    /// @param assetId Address of token
    /// @param bridge Address of bridge for asset
    function registerOpBNBBridge(address assetId, address bridge) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (bridge == address(0)) {
            revert InvalidConfig();
        }

        s.bridges[assetId] = IL1StandardBridge(bridge);

        emit OptimismBridgeRegistered(assetId, bridge);
    }

    /// @notice Bridges tokens via OpBNB Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _opBNBData Data specific to OpBNB Bridge
    function startBridgeTokensViaOpBNBBridge(
        ILiFi.BridgeData calldata _bridgeData,
        OpBNBData calldata _opBNBData
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
        _startBridge(_bridgeData, _opBNBData);
    }

    /// @notice Performs a swap before bridging via OpBNB Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
    /// @param _bridgeData Data specific to OpBNB Bridge
    function swapAndStartBridgeTokensViaOpBNBBridge(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        OpBNBData calldata _opBNBData
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
        _startBridge(_bridgeData, _opBNBData);
    }

    /// Private Methods ///

    /// @dev Contains the business logic for the bridge via OpBNB Bridge
    /// @param _bridgeData Data contaning core information for bridging
    /// @param _bridgeData Data specific to OpBNB Bridge
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        OpBNBData calldata _opBNBData
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
                _opBNBData.l2Gas,
                ""
            );
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(bridge),
                _bridgeData.minAmount
            );

            if (_opBNBData.isSynthetix) {
                bridge.depositTo(_bridgeData.receiver, _bridgeData.minAmount);
            } else {
                bridge.depositERC20To(
                    _bridgeData.sendingAssetId,
                    _opBNBData.assetIdOnL2,
                    _bridgeData.receiver,
                    _bridgeData.minAmount,
                    _opBNBData.l2Gas,
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
