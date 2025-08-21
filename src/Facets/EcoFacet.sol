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
/// @notice Bridges assets via Eco Protocol's Routes cross-chain intent system
/// @custom:version 2.0.0
contract EcoFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable {
    /// Immutable Storage ///

    /// @notice Default prover address for intent verification
    address public immutable DEFAULT_PROVER;

    /// Types ///

    /// @notice Bridge-specific data for Eco Protocol
    /// @param portal Address of the Portal contract on current chain
    /// @param destinationPortal Address of the Portal contract on destination chain
    /// @param prover Prover address for intent verification (optional, uses default if zero)
    /// @param routeDeadline Deadline for route execution on destination chain
    /// @param rewardDeadline Deadline for reward claims
    /// @param salt Unique salt for the route to prevent duplicates
    /// @param calls Array of calls to execute on destination chain
    /// @param allowPartial Whether to allow partial fulfillment
    struct EcoData {
        address portal;
        address destinationPortal;
        address prover;
        uint64 routeDeadline;
        uint64 rewardDeadline;
        bytes32 salt;
        IEco.Call[] calls;
        bool allowPartial;
    }

    /// Errors ///

    error InvalidProver();
    error InvalidDeadline();

    /// Modifiers ///

    modifier validateEcoData(EcoData calldata _ecoData) {
        if (_ecoData.portal == address(0)) revert InvalidContract();
        if (
            _ecoData.routeDeadline <= block.timestamp ||
            _ecoData.rewardDeadline <= block.timestamp
        ) {
            revert InvalidDeadline();
        }
        _;
    }

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
    /// @param _ecoData Eco-specific parameters including Portal address
    function startBridgeTokensViaEco(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    )
        external
        payable
        nonReentrant
        refundExcessNative(payable(msg.sender))
        validateBridgeData(_bridgeData)
        validateEcoData(_ecoData)
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
    /// @param _ecoData Eco-specific parameters including Portal address
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
        validateEcoData(_ecoData)
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
        // Prepare token arrays for the route
        IEco.TokenAmount[] memory routeTokens = new IEco.TokenAmount[](1);
        routeTokens[0] = IEco.TokenAmount({
            token: _bridgeData.sendingAssetId,
            amount: _bridgeData.minAmount
        });

        // Create the route
        IEco.Route memory route = IEco.Route({
            salt: _ecoData.salt,
            deadline: _ecoData.routeDeadline,
            portal: _ecoData.destinationPortal,
            tokens: routeTokens,
            calls: _ecoData.calls
        });

        // Compute route hash
        bytes32 routeHash = keccak256(abi.encode(route));

        // Use provided prover or fall back to default
        address prover = _ecoData.prover != address(0)
            ? _ecoData.prover
            : DEFAULT_PROVER;

        // Prepare reward structure
        // For native token bridging, we need to specify the native amount in the reward
        uint256 rewardNativeAmount = LibAsset.isNativeAsset(
            _bridgeData.sendingAssetId
        )
            ? _bridgeData.minAmount
            : 0;

        IEco.TokenAmount[] memory rewardTokens = new IEco.TokenAmount[](0);

        IEco.Reward memory reward = IEco.Reward({
            deadline: _ecoData.rewardDeadline,
            creator: msg.sender,
            prover: prover,
            nativeAmount: rewardNativeAmount,
            tokens: rewardTokens
        });

        // Approve tokens if needed (not native asset)
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                _ecoData.portal,
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

        // Fund the intent (publish is optional for solver discovery)
        IEco(_ecoData.portal).fund{ value: nativeValue }(
            uint64(_bridgeData.destinationChainId),
            routeHash,
            reward,
            _ecoData.allowPartial
        );
    }
}
