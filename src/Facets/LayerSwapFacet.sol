// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { ILayerSwapDepository } from "../Interfaces/ILayerSwapDepository.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { InvalidCallData, InvalidConfig } from "../Errors/GenericErrors.sol";

/// @title LayerSwap Facet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through the LayerSwap
///         Depository contract
/// @custom:version 1.0.0
contract LayerSwapFacet is
    ILiFi,
    ReentrancyGuard,
    SwapperV2,
    Validatable,
    LiFiData
{
    /// Storage ///

    /// @notice Address of the LayerSwap Depository contract
    // solhint-disable-next-line immutable-vars-naming
    address public immutable LAYERSWAP_DEPOSITORY;

    /// Types ///

    /// @dev LayerSwap specific parameters
    /// @param requestId LayerSwap swap id (from POST /api/v2/swaps),
    ///        passed as the `id` argument to the depository
    /// @param depositoryReceiver Whitelisted address that the LayerSwap
    ///        Depository forwards the deposited funds to on the source
    ///        chain; supplied by the LI.FI backend per call. Distinct
    ///        from `bridgeData.receiver`, which is the final recipient
    ///        on the destination chain.
    /// @param nonEVMReceiver set only if bridging to non-EVM chain
    struct LayerSwapData {
        bytes32 requestId;
        address depositoryReceiver;
        bytes32 nonEVMReceiver;
    }

    /// Errors ///

    error InvalidNonEVMReceiver();

    /// Constructor ///

    /// @param _layerSwapDepository address of the LayerSwap Depository
    ///        contract on the source chain
    constructor(address _layerSwapDepository) {
        if (_layerSwapDepository == address(0)) {
            revert InvalidConfig();
        }
        LAYERSWAP_DEPOSITORY = _layerSwapDepository;
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
    ) internal pure {
        if (_layerSwapData.depositoryReceiver == address(0)) {
            revert InvalidCallData();
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
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            ILayerSwapDepository(LAYERSWAP_DEPOSITORY).depositNative{
                value: _bridgeData.minAmount
            }(_layerSwapData.requestId, _layerSwapData.depositoryReceiver);
        } else {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                LAYERSWAP_DEPOSITORY,
                _bridgeData.minAmount
            );

            ILayerSwapDepository(LAYERSWAP_DEPOSITORY).depositERC20(
                _layerSwapData.requestId,
                _bridgeData.sendingAssetId,
                _layerSwapData.depositoryReceiver,
                _bridgeData.minAmount
            );
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
}
