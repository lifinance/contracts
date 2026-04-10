// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { LibUtil } from "../Libraries/LibUtil.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title LayerSwap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through LayerSwap
/// @custom:version 1.0.0
contract LayerSwapFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    bytes32 internal constant NAMESPACE =
        keccak256("com.lifi.facets.layerswap");

    /// @dev Diamond storage for LayerSwap facet
    struct Storage {
        mapping(bytes32 => bool) consumedIds;
    }

    // solhint-disable-next-line immutable-vars-naming
    address public immutable LAYERSWAP_TARGET;

    /// Types ///

    /// @dev LayerSwap specific parameters
    /// @param requestId LayerSwap API request ID
    /// @param nonEVMReceiver set only if bridging to non-EVM chain
    struct LayerSwapData {
        bytes32 requestId;
        bytes32 nonEVMReceiver;
    }

    /// Errors ///

    error RequestAlreadyProcessed();
    error InvalidNonEVMReceiver();

    /// Constructor ///

    /// @param _layerSwapTarget address of the LayerSwap target
    ///        on the source chain
    constructor(address _layerSwapTarget) {
        if (_layerSwapTarget == address(0)) {
            revert InvalidConfig();
        }
        LAYERSWAP_TARGET = _layerSwapTarget;
    }

    /// External Methods ///

    /// @notice Bridges tokens via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function startBridgeTokensViaLayerSwap(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
    {
        _validateLayerSwapData(_bridgeData, _layerSwapData);
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _layerSwapData);
    }

    /// @notice Performs a swap before bridging via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing
    ///        swaps before bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function swapAndStartBridgeTokensViaLayerSwap(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        LayerSwapData calldata _layerSwapData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        containsSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        validateBridgeData(_bridgeData)
    {
        _validateLayerSwapData(_bridgeData, _layerSwapData);
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _layerSwapData);
    }

    /// Internal Methods ///

    /// @dev Validates LayerSwap-specific data
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function _validateLayerSwapData(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    ) internal view {
        if (getStorage().consumedIds[_layerSwapData.requestId]) {
            revert RequestAlreadyProcessed();
        }
        if (
            _bridgeData.receiver == NON_EVM_ADDRESS &&
            _layerSwapData.nonEVMReceiver == bytes32(0)
        ) {
            revert InvalidNonEVMReceiver();
        }
    }

    /// @dev Contains the business logic for the bridge via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    ) internal {
        getStorage().consumedIds[_layerSwapData.requestId] = true;

        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            // Native: send to LAYERSWAP_TARGET with requestId as data
            (bool success, bytes memory reason) = LAYERSWAP_TARGET.call{
                value: _bridgeData.minAmount
            }(abi.encode(_layerSwapData.requestId));
            if (!success) {
                revert(LibUtil.getRevertMsg(reason));
            }
        } else {
            // ERC20: build transfer calldata with requestId appended
            bytes memory transferCallData = bytes.concat(
                abi.encodeWithSignature(
                    "transfer(address,uint256)",
                    LAYERSWAP_TARGET,
                    _bridgeData.minAmount
                ),
                abi.encode(_layerSwapData.requestId)
            );
            (bool success, bytes memory reason) = address(
                _bridgeData.sendingAssetId
            ).call(transferCallData);
            if (!success) {
                revert(LibUtil.getRevertMsg(reason));
            }
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChainBytes32(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _layerSwapData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    /// @notice Check if a request ID has already been processed
    /// @param _requestId The request ID to check
    /// @return true if the request ID has been consumed
    function consumedIds(
        bytes32 _requestId
    ) external view returns (bool) {
        return getStorage().consumedIds[_requestId];
    }

    /// @dev fetch diamond storage
    function getStorage() private pure returns (Storage storage s) {
        bytes32 namespace = NAMESPACE;
        // solhint-disable-next-line no-inline-assembly
        assembly {
            s.slot := namespace
        }
    }
}
