// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IHopBridge } from "../Interfaces/IHopBridge.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { CannotBridgeToSameNetwork, NativeValueWithERC, InvalidReceiver, InvalidAmount, InvalidConfig, InvalidSendingToken, AlreadyInitialized, NotInitialized } from "../Errors/GenericErrors.sol";
import { SwapperV2, LibSwap } from "../Helpers/SwapperV2.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title Hop Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Hop
contract HopFacetOptimized is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.hop");

    struct Storage {
        mapping(address => IHopBridge) bridges;
        bool initialized;
    }

    /// Types ///

    struct Config {
        address assetId;
        address bridge;
    }

    struct HopData {
        uint256 bonderFee;
        uint256 amountOutMin;
        uint256 deadline;
        uint256 destinationAmountOutMin;
        uint256 destinationDeadline;
    }

    /// Events ///

    event HopInitialized(Config[] configs);
    event HopBridgeRegistered(address indexed assetId, address bridge);

    /// Init ///

    /// @notice Initialize local variables for the Hop Facet
    /// @param configs Bridge configuration data
    function initHop(Config[] calldata configs) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (s.initialized) {
            revert AlreadyInitialized();
        }

        for (uint256 i = 0; i < configs.length; i++) {
            if (configs[i].bridge == address(0)) {
                revert InvalidConfig();
            }
            s.bridges[configs[i].assetId] = IHopBridge(configs[i].bridge);
        }

        s.initialized = true;

        emit HopInitialized(configs);
    }

    /// External Methods ///

    /// @notice Register token and bridge
    /// @param assetId Address of token
    /// @param bridge Address of bridge for asset
    function registerBridge(address assetId, address bridge) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();

        if (!s.initialized) {
            revert NotInitialized();
        }

        if (bridge == address(0)) {
            revert InvalidConfig();
        }

        s.bridges[assetId] = IHopBridge(bridge);

        emit HopBridgeRegistered(assetId, bridge);
    }

    /// @notice Bridges tokens via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function startBridgeTokensViaHop(ILiFi.BridgeData memory _bridgeData, HopData calldata _hopData)
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
    {
        LibAsset.depositAsset(_bridgeData.sendingAssetId, _bridgeData.minAmount);
        _startBridge(_bridgeData, _hopData);
    }

    /// @notice Performs a swap before bridging via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _swapData an array of swap related data for performing swaps before bridging
    /// @param _hopData data specific to Hop Protocol
    function swapAndStartBridgeTokensViaHop(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        HopData memory _hopData
    ) external payable nonReentrant refundExcessNative(payable(msg.sender)) {
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _hopData);
    }

    /// private Methods ///

    /// @dev Contains the business logic for the bridge via Hop Protocol
    /// @param _bridgeData the core information needed for bridging
    /// @param _hopData data specific to Hop Protocol
    function _startBridge(ILiFi.BridgeData memory _bridgeData, HopData memory _hopData) private {
        // Do HOP stuff
        if (block.chainid == _bridgeData.destinationChainId) revert CannotBridgeToSameNetwork();

        address sendingAssetId = _bridgeData.sendingAssetId;
        Storage storage s = getStorage();
        IHopBridge bridge = s.bridges[sendingAssetId];

        // Give Hop approval to bridge tokens
        LibAsset.maxApproveERC20(IERC20(sendingAssetId), address(bridge), _bridgeData.minAmount);

        uint256 value = LibAsset.isNativeAsset(address(sendingAssetId)) ? _bridgeData.minAmount : 0;

        if (block.chainid == 1) {
            // Ethereum L1
            bridge.sendToL2{ value: value }(
                _bridgeData.destinationChainId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline,
                address(0),
                0
            );
        } else {
            // L2
            // solhint-disable-next-line check-send-result
            bridge.swapAndSend{ value: value }(
                _bridgeData.destinationChainId,
                _bridgeData.receiver,
                _bridgeData.minAmount,
                _hopData.bonderFee,
                _hopData.amountOutMin,
                _hopData.deadline,
                _hopData.destinationAmountOutMin,
                _hopData.destinationDeadline
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
