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
    IEcoPortal public immutable intentSource;

    /// Types ///

    /// @dev Eco specific parameters
    /// @param receiverAddress Address that will receive tokens on destination chain
    /// @param nonEVMReceiver Destination address for non-EVM chains (bytes format)
    /// @param receivingAssetId Address of the token to receive on destination
    /// @param salt Unique identifier for the intent (prevent duplicates)
    /// @param destinationInbox Inbox address on destination chain
    /// @param prover Address of the prover contract for validation
    /// @param rewardDeadline Timestamp for reward claim eligibility
    /// @param solverReward Native token amount to reward the solver
    /// @param destinationCalls Optional calls to execute on destination
    struct EcoData {
        address receiverAddress;
        bytes nonEVMReceiver;
        address receivingAssetId;
        bytes32 salt;
        address destinationInbox;
        address prover;
        uint64 rewardDeadline;
        uint256 solverReward;
        IEcoPortal.Call[] destinationCalls;
    }

    /// Constructor ///

    constructor(IEcoPortal _intentSource) {
        if (address(_intentSource) == address(0)) {
            revert InvalidConfig();
        }
        intentSource = _intentSource;
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

    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal {
        IEcoPortal.Call[] memory routeCalls = _buildRouteCalls(
            _bridgeData,
            _ecoData
        );

        IEcoPortal.TokenAmount[] memory routeTokens = _buildRouteTokens(
            _bridgeData,
            _ecoData
        );

        IEcoPortal.Intent memory intent = _buildIntent(
            _bridgeData,
            _ecoData,
            routeCalls,
            routeTokens
        );

        _publishIntent(_bridgeData, _ecoData, intent);

        _emitEvents(_bridgeData, _ecoData);
    }

    function _validateEcoData(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private pure {
        if (
            (_ecoData.destinationCalls.length > 0) !=
            _bridgeData.hasDestinationCall
        ) {
            revert InformationMismatch();
        }

        if (
            !_bridgeData.hasDestinationCall &&
            _bridgeData.receiver != NON_EVM_ADDRESS &&
            _bridgeData.receiver != _ecoData.receiverAddress
        ) {
            revert InformationMismatch();
        }

        if (
            _bridgeData.receiver == NON_EVM_ADDRESS &&
            _ecoData.nonEVMReceiver.length == 0
        ) {
            revert InvalidReceiver();
        }
    }

    function _buildRouteCalls(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private pure returns (IEcoPortal.Call[] memory) {
        if (_ecoData.destinationCalls.length > 0) {
            return _ecoData.destinationCalls;
        }

        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            return new IEcoPortal.Call[](0);
        }

        IEcoPortal.Call[] memory routeCalls = new IEcoPortal.Call[](1);

        if (!LibAsset.isNativeAsset(_ecoData.receivingAssetId)) {
            routeCalls[0] = IEcoPortal.Call({
                target: _ecoData.receivingAssetId,
                data: abi.encodeWithSignature(
                    "transfer(address,uint256)",
                    _ecoData.receiverAddress,
                    _bridgeData.minAmount
                ),
                value: 0
            });
        } else {
            routeCalls[0] = IEcoPortal.Call({
                target: _ecoData.receiverAddress,
                data: "",
                value: _bridgeData.minAmount
            });
        }

        return routeCalls;
    }

    function _buildRouteTokens(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private pure returns (IEcoPortal.TokenAmount[] memory) {
        // Route tokens are the tokens needed on the destination chain
        // If receiving native, no tokens needed
        if (LibAsset.isNativeAsset(_ecoData.receivingAssetId)) {
            return new IEcoPortal.TokenAmount[](0);
        }

        // If receiving ERC20, we need those tokens on destination
        IEcoPortal.TokenAmount[]
            memory routeTokens = new IEcoPortal.TokenAmount[](1);
        routeTokens[0] = IEcoPortal.TokenAmount({
            token: _ecoData.receivingAssetId,
            amount: _bridgeData.minAmount
        });

        return routeTokens;
    }

    function _buildIntent(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData,
        IEcoPortal.Call[] memory routeCalls,
        IEcoPortal.TokenAmount[] memory routeTokens
    ) private view returns (IEcoPortal.Intent memory) {
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);

        // Build reward tokens array for ERC20
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
            IEcoPortal.Intent({
                route: IEcoPortal.Route({
                    salt: _ecoData.salt,
                    source: block.chainid,
                    destination: _bridgeData.destinationChainId,
                    inbox: _ecoData.destinationInbox,
                    tokens: routeTokens,
                    calls: routeCalls
                }),
                reward: IEcoPortal.Reward({
                    creator: msg.sender, // Address that can cancel/retrieve refund
                    prover: _ecoData.prover,
                    deadline: _ecoData.rewardDeadline,
                    nativeValue: isNative
                        ? _ecoData.solverReward + _bridgeData.minAmount
                        : 0, // No native amount for ERC20
                    tokens: rewardTokens // Include token reward for ERC20
                })
            });
    }

    function _publishIntent(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData,
        IEcoPortal.Intent memory intent
    ) private {
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);

        if (isNative) {
            intentSource.publishAndFund{
                value: _bridgeData.minAmount + _ecoData.solverReward
            }(intent, false);
        } else {
            // For ERC20: approve total amount (bridge + reward)
            uint256 totalAmount = _bridgeData.minAmount +
                _ecoData.solverReward;
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(intentSource),
                totalAmount
            );

            // No native value needed for ERC20 rewards
            intentSource.publishAndFund(intent, false);
        }
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
