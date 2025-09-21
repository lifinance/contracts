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
import { InvalidConfig, InvalidReceiver, InformationMismatch, InvalidCallData } from "../Errors/GenericErrors.sol";

/// @title EcoFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Eco Protocol
/// @custom:version 1.0.0
contract EcoFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    /// Storage ///

    IEcoPortal public immutable PORTAL;
    uint64 private immutable ECO_CHAIN_ID_TRON = 728126428;
    uint64 private immutable ECO_CHAIN_ID_SOLANA = 1399811149;

    /// Types ///

    /// @dev Eco specific parameters
    /// @param receiverAddress Address that will receive tokens on destination chain
    /// @param nonEVMReceiver Destination address for non-EVM chains (bytes format)
    /// @param prover Address of the prover contract for validation
    /// @param rewardDeadline Timestamp for reward claim eligibility
    /// @param solverReward Reward amount for the solver (native or ERC20 depending on sendingAssetId)
    /// @param encodedRoute Encoded route data containing destination chain routing information
    struct EcoData {
        address receiverAddress;
        bytes nonEVMReceiver;
        address prover;
        uint64 rewardDeadline;
        uint256 solverReward;
        bytes encodedRoute;
    }

    /// Constructor ///

    /// @notice Initializes the EcoFacet with the Eco Portal contract
    /// @param _portal Address of the Eco Portal contract
    constructor(IEcoPortal _portal) {
        if (address(_portal) == address(0)) {
            revert InvalidConfig();
        }
        PORTAL = _portal;
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
        doesNotContainDestinationCalls(_bridgeData)
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
        doesNotContainDestinationCalls(_bridgeData)
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
    ) private view returns (uint64) {
        // Map LiFi Tron chain ID to Eco protocol Tron chain ID
        if (_lifiChainId == LIFI_CHAIN_ID_TRON) {
            return ECO_CHAIN_ID_TRON;
        }
        // Map LiFi Solana chain ID to Eco protocol Solana chain ID
        if (_lifiChainId == LIFI_CHAIN_ID_SOLANA) {
            return ECO_CHAIN_ID_SOLANA;
        }

        // For EVM chains, ensure the chain ID fits within uint64 bounds
        // Most EVM chain IDs are well below this limit, but we check to be safe
        if (_lifiChainId > type(uint64).max) {
            revert InvalidConfig();
        }

        return uint64(_lifiChainId);
    }

    function _buildReward(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData,
        bool isNative,
        uint256 totalAmount
    ) private view returns (IEcoPortal.Reward memory) {
        IEcoPortal.TokenAmount[] memory rewardTokens;
        if (!isNative) {
            rewardTokens = new IEcoPortal.TokenAmount[](1);
            rewardTokens[0] = IEcoPortal.TokenAmount({
                token: _bridgeData.sendingAssetId,
                amount: totalAmount
            });
        } else {
            rewardTokens = new IEcoPortal.TokenAmount[](0);
        }

        return
            IEcoPortal.Reward({
                creator: msg.sender,
                prover: _ecoData.prover,
                deadline: _ecoData.rewardDeadline,
                nativeAmount: isNative ? totalAmount : 0,
                tokens: rewardTokens
            });
    }

    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal {
        // Calculate values once
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        uint256 totalAmount = _bridgeData.minAmount + _ecoData.solverReward;

        // Build reward for the intent
        IEcoPortal.Reward memory reward = _buildReward(
            _bridgeData,
            _ecoData,
            isNative,
            totalAmount
        );

        // Get the destination chain ID in Eco format
        uint64 destination = _getEcoChainId(_bridgeData.destinationChainId);

        // Prepare token approval if needed for ERC20 tokens
        if (!isNative) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(PORTAL),
                totalAmount
            );
        }

        /// @dev IMPORTANT LIMITATION: For ERC20 tokens, positive slippage from pre-bridge swaps
        /// may be lost in the diamond. The intent input amount is encoded in encodedRoute and we only
        /// pass the reward amount separately. While native token positive slippage is handled by sending
        /// more funds, ERC20 positive slippage cannot be captured with the current implementation.
        /// This is a known limitation that can be significant when bridging large amounts.
        /// Users should be aware that they may not receive positive slippage benefits for ERC20 swaps.

        // Publish and fund the intent with encoded route
        PORTAL.publishAndFund{ value: isNative ? totalAmount : 0 }(
            destination,
            _ecoData.encodedRoute,
            reward,
            false // allowPartial
        );

        _emitEvents(_bridgeData, _ecoData);
    }

    function _validateEcoData(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private view {
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
            _bridgeData.receiver != NON_EVM_ADDRESS &&
            _bridgeData.receiver != _ecoData.receiverAddress
        ) {
            revert InformationMismatch();
        }

        // Validate that the route sends to the correct receiver
        _validateRouteReceiver(_bridgeData, _ecoData);
    }

    function _validateRouteReceiver(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private view {
        // Skip validation for NON_EVM_ADDRESS as it uses nonEVMReceiver
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            return;
        }

        // For EVM and EVM-compatible chains (including Tron),
        // the route MUST end with an ERC20 transfer call
        if (_isEVMChain(_bridgeData.destinationChainId)) {
            uint256 routeLength = _ecoData.encodedRoute.length;

            // Route must be at least 68 bytes to contain a transfer call
            // 4 bytes selector + 32 bytes address + 32 bytes amount = 68 bytes
            if (routeLength < 68) {
                revert InvalidCallData();
            }

            // Extract the last 68 bytes which MUST be the transfer call
            uint256 transferOffset = routeLength - 68;

            // Verify the selector at the transfer offset position
            bytes4 selector = bytes4(
                _ecoData.encodedRoute[transferOffset:transferOffset + 4]
            );
            if (selector != bytes4(0xa9059cbb)) {
                revert InvalidCallData();
            }

            // Extract and decode the recipient address (next 32 bytes after selector)
            // The address is padded to 32 bytes in the ABI encoding
            address decodedReceiver = address(
                uint160(
                    bytes20(
                        _ecoData.encodedRoute[transferOffset +
                            16:transferOffset + 36]
                    )
                )
            );

            // The decoded receiver MUST match the bridge data receiver
            if (decodedReceiver != _bridgeData.receiver) {
                revert InformationMismatch();
            }
        }
        // For truly non-EVM chains (only Solana), no route validation
        // Solana uses a different encoding (CalldataWithAccounts) that requires specific handling
    }

    function _isEVMChain(uint256 chainId) private view returns (bool) {
        // Only Solana is truly non-EVM
        // Tron uses EVM-compatible contracts and transfer patterns
        if (chainId == LIFI_CHAIN_ID_SOLANA) {
            return false;
        }
        // Tron and other chains use EVM-compatible transfer encoding
        return true;
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
