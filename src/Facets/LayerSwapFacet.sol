// SPDX-License-Identifier: LGPL-3.0
pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { LibDiamond } from "../Libraries/LibDiamond.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";

/// @title LayerSwap Facet
/// @author LI.FI (https://li.fi)
/// @notice Enables cross-chain asset bridging and swapping
/// @custom:version 1.0.0
contract LayerSwapFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Storage ///

    bytes32 internal constant NAMESPACE = keccak256("com.lifi.facets.layerswap"); // Optional. Only use if you need to store data in the diamond storage.

    /// @dev Local storage for the contract (optional)
    struct Storage {
        address[] exampleAllowedTokens;
    }

    address public immutable example;

    /// Types ///

    /// @dev Optional bridge specific struct
    /// @param exampleParam Example parameter
    struct LayerSwapData {
      string exampleParam;
    }

    /// Events ///

    event LayerSwapInitialized();

    /// Constructor ///

    /// @notice Constructor for the contract.
    ///         Should only be used to set immutable variables.
    ///         Anything that cannot be set as immutable should be set
    ///         in an init() function called during a diamondCut().
    /// @param _example Example parameter.
    constructor(address _example) {
        example = _example;
    }

    /// Init ///

    /// @notice Init function. Called in the context
    ///         of the diamond contract when added as part of
    ///         a diamondCut(). Use for config that can't be
    ///         set as immutable or needs to change for any reason.
    /// @param _exampleAllowedTokens Example array of allowed tokens for this chain.
    function initLayerSwap(address[] memory _exampleAllowedTokens) external {
        LibDiamond.enforceIsContractOwner();

        Storage storage s = getStorage();
        s.exampleAllowedTokens = _exampleAllowedTokens;

        emit LayerSwapInitialized();
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
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );
        _startBridge(_bridgeData, _layerSwapData);
    }

    /// @notice Performs a swap before bridging via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _swapData An array of swap related data for performing swaps before bridging
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
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender)
        );
        _startBridge(_bridgeData, _layerSwapData);
    }

    /// Internal Methods ///

    /// @dev Contains the business logic for the bridge via LayerSwap
    /// @param _bridgeData The core information needed for bridging
    /// @param _layerSwapData Data specific to LayerSwap
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        LayerSwapData calldata _layerSwapData
    ) internal {
        // TODO: Implement business logic
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
