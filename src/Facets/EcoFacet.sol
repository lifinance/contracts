// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

import { ILiFi } from "../Interfaces/ILiFi.sol";
import { IEcoPortal } from "../Interfaces/IEcoPortal.sol";
import { LibAsset } from "../Libraries/LibAsset.sol";
import { LibSwap } from "../Libraries/LibSwap.sol";
import { ReentrancyGuard } from "../Helpers/ReentrancyGuard.sol";
import { SwapperV2 } from "../Helpers/SwapperV2.sol";
import { Validatable } from "../Helpers/Validatable.sol";
import { LiFiData } from "../Helpers/LiFiData.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { InvalidConfig, InvalidReceiver, InformationMismatch } from "../Errors/GenericErrors.sol";

/// @title EcoFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Eco Protocol
/// @custom:version 1.0.0
contract EcoFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    /// Storage ///

    // solhint-disable-next-line immutable-vars-naming
    IEcoPortal public immutable portal;

    /// Types ///

    /// @dev Eco specific parameters
    /// @param receiverAddress Address that will receive tokens on destination chain
    /// @param nonEVMReceiver Destination address for non-EVM chains (bytes format)
    /// @param prover Address of the prover contract for validation
    /// @param rewardDeadline Timestamp for reward claim eligibility
    /// @param solverReward Native token amount to reward the solver
    /// @param encodedRoute Encoded route data for all chains
    struct EcoData {
        address receiverAddress;
        bytes nonEVMReceiver;
        address prover;
        uint64 rewardDeadline;
        uint256 solverReward;
        bytes encodedRoute;
    }

    /// Constructor ///

    constructor(IEcoPortal _portal) {
        if (address(_portal) == address(0)) {
            revert InvalidConfig();
        }
        portal = _portal;
    }

    /// External Methods ///

    /// @notice Bridges tokens via Eco Protocol
    /// @param _bridgeData Bridge data containing core parameters
    /// @param _ecoData Eco-specific parameters for the bridge
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
    {
        // Validate eco-specific data before depositing
        _validateEcoData(_bridgeData, _ecoData);

        // For ERC20, we need to deposit the full amount including reward
        uint256 depositAmount = _bridgeData.minAmount;
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            depositAmount += _ecoData.solverReward;
        }

        LibAsset.depositAsset(_bridgeData.sendingAssetId, depositAmount);

        _startBridge(_bridgeData, _ecoData);
    }

    /// @notice Swaps and bridges tokens via Eco Protocol
    /// @param _bridgeData Bridge data containing core parameters
    /// @param _swapData Array of swap data for source swaps
    /// @param _ecoData Eco-specific parameters for the bridge
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
        validateBridgeData(_bridgeData)
    {
        // Validate eco-specific data before swapping
        _validateEcoData(_bridgeData, _ecoData);

        // For ERC20 tokens, we need to reserve the solver reward from the swapped amount
        // Only pass native fee reservation if the final asset is native
        uint256 nativeFeeAmount = LibAsset.isNativeAsset(
            _bridgeData.sendingAssetId
        )
            ? _ecoData.solverReward
            : 0;

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            nativeFeeAmount
        );

        // For ERC20 tokens, the swap result includes the solver reward
        // We need to subtract it to get the actual bridge amount
        if (!LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            _bridgeData.minAmount =
                _bridgeData.minAmount -
                _ecoData.solverReward;
        }

        _startBridge(_bridgeData, _ecoData);
    }

    /// Internal Methods ///


    function _getEcoChainId(
        uint256 _lifiChainId
    ) private pure returns (uint64) {
        // Map LiFi Tron chain ID to Eco protocol Tron chain ID
        if (_lifiChainId == LIFI_CHAIN_ID_TRON) {
            return 728126428; // Eco protocol's Tron chain ID
        }
        // Map LiFi Solana chain ID to Eco protocol Solana chain ID
        if (_lifiChainId == LIFI_CHAIN_ID_SOLANA) {
            return 1399811149; // Eco protocol's Solana chain ID
        }
        // For all other chains (EVM), pass through as-is
        return uint64(_lifiChainId);
    }

    function _buildReward(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private view returns (IEcoPortal.Reward memory) {
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);

        IEcoPortal.TokenAmount[] memory rewardTokens;
        if (!isNative) {
            rewardTokens = new IEcoPortal.TokenAmount[](1);
            rewardTokens[0] = IEcoPortal.TokenAmount({
                token: _bridgeData.sendingAssetId,
                amount: _bridgeData.minAmount + _ecoData.solverReward
            });
        } else {
            rewardTokens = new IEcoPortal.TokenAmount[](0);
        }

        return
            IEcoPortal.Reward({
                creator: msg.sender,
                prover: _ecoData.prover,
                deadline: _ecoData.rewardDeadline,
                nativeAmount: isNative
                    ? _ecoData.solverReward + _bridgeData.minAmount
                    : 0,
                tokens: rewardTokens
            });
    }

    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal {
        // Build reward and use encoded route for all chains
        IEcoPortal.Intent memory intent;
        intent.reward = _buildReward(_bridgeData, _ecoData);
        intent.destination = _getEcoChainId(_bridgeData.destinationChainId);
        _publishIntent(_bridgeData, _ecoData, intent);

        _emitEvents(_bridgeData, _ecoData);
    }

    function _validateEcoData(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private pure {
        // encodedRoute is required for all chains
        if (_ecoData.encodedRoute.length == 0) {
            revert InvalidConfig();
        }

        // Validation for NON_EVM_ADDRESS receiver
        if (
            _bridgeData.receiver == NON_EVM_ADDRESS &&
            _ecoData.nonEVMReceiver.length == 0
        ) {
            revert InvalidReceiver();
        }

        // For standard receivers, check address match
        if (
            !_bridgeData.hasDestinationCall &&
            _bridgeData.receiver != NON_EVM_ADDRESS &&
            _bridgeData.receiver != _ecoData.receiverAddress
        ) {
            revert InformationMismatch();
        }
    }


    function _publishIntent(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData,
        IEcoPortal.Intent memory intent
    ) private {
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        uint256 totalValue = isNative
            ? _bridgeData.minAmount + _ecoData.solverReward
            : 0;

        // Prepare token approval if needed
        if (!isNative) {
            uint256 totalAmount = _bridgeData.minAmount +
                _ecoData.solverReward;
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(portal),
                totalAmount
            );
        }

        // Use encoded route for all chains
        portal.publishAndFund{value: totalValue}(
            _getEcoChainId(_bridgeData.destinationChainId),
            _ecoData.encodedRoute,
            intent.reward,
            false
        );
    }

    function _emitEvents(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private {
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _ecoData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }
}
