// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IEco } from "../Interfaces/IEco.sol";
import { LibAsset, IERC20 } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { InvalidContract } from "../Errors/GenericErrors.sol";

/// @title Eco Facet
/// @author LI.FI (https://li.fi)
/// @notice Bridges assets via Eco Protocol's intent system
/// @custom:version 1.0.0
contract EcoFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Immutable Storage ///

    /// @notice Default prover address for intent verification
    address public immutable DEFAULT_PROVER;

    /// Types ///

    /// @notice Bridge-specific data for Eco Protocol
    /// @param intentSource Address of the Intent Source contract on current chain
    /// @param receiver Receiver address on destination chain
    /// @param prover Prover address for intent verification (optional, uses default if zero)
    /// @param deadline Intent deadline timestamp
    /// @param nonce Unique nonce for the intent
    /// @param routeData Additional route data for destination execution
    /// @param allowPartial Whether to allow partial fulfillment
    struct EcoData {
        address intentSource;
        address receiver;
        address prover;
        uint256 deadline;
        uint256 nonce;
        bytes routeData;
        bool allowPartial;
    }

    /// Errors ///

    error InvalidProver();
    error InvalidDeadline();

    /// Constructor ///

    /// @notice Initialize the facet with immutable configuration
    /// @param _defaultProver Default prover contract address
    constructor(address _defaultProver) {
        if (_defaultProver == address(0)) revert InvalidProver();
        DEFAULT_PROVER = _defaultProver;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Eco Protocol
    /// @param _bridgeData Core bridge data
    /// @param _ecoData Eco-specific parameters including Intent Source address
    function startBridgeTokensViaEco(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
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
        _startBridge(_bridgeData, _ecoData);
    }

    /// @notice Performs swaps before bridging via Eco Protocol
    /// @param _bridgeData Core bridge data
    /// @param _swapData Array of swap operations
    /// @param _ecoData Eco-specific parameters including Intent Source address
    function swapAndStartBridgeTokensViaEco(
        ILiFi.BridgeData memory _bridgeData,
        LibSwap.SwapData[] calldata _swapData,
        EcoData calldata _ecoData
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
        _startBridge(_bridgeData, _ecoData);
    }

    /// Internal Methods ///

    /// @dev Executes the bridge via Eco Protocol
    /// @param _bridgeData Core bridge data
    /// @param _ecoData Eco-specific parameters
    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal {
        // Validate Intent Source address
        if (_ecoData.intentSource == address(0)) {
            revert InvalidContract();
        }

        // Validate deadline
        if (_ecoData.deadline <= block.timestamp) {
            revert InvalidDeadline();
        }

        // Prepare intent components
        IEco.Route memory route = IEco.Route({
            source: address(this),
            destination: _bridgeData.destinationChainId,
            data: _ecoData.routeData
        });

        // Prepare reward arrays
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = _bridgeData.sendingAssetId;
        amounts[0] = _bridgeData.minAmount;

        // Use provided prover or fall back to default
        address prover = _ecoData.prover != address(0)
            ? _ecoData.prover
            : DEFAULT_PROVER;

        IEco.Reward memory reward = IEco.Reward({
            prover: prover,
            tokens: tokens,
            amounts: amounts,
            deadline: _ecoData.deadline,
            nonce: _ecoData.nonce
        });

        IEco.Intent memory intent = IEco.Intent({
            route: route,
            reward: reward
        });

        // Approve tokens if needed (not native asset)
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                _ecoData.intentSource,
                _bridgeData.minAmount
            );
        }

        // Calculate native value to send
        uint256 nativeValue = LibAsset.isNativeAsset(
            _bridgeData.sendingAssetId
        )
            ? _bridgeData.minAmount
            : 0;

        // Emit event before external call
        emit LiFiTransferStarted(_bridgeData);

        // Create and fund intent
        IEco(_ecoData.intentSource).publishAndFund{ value: nativeValue }(
            intent,
            _ecoData.allowPartial
        );
    }
}
