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
    /// @param routeDeadline Timestamp by which route must be executed
    /// @param destinationPortal Portal address on destination chain
    /// @param prover Address of the prover contract for validation
    /// @param rewardDeadline Timestamp for reward claim eligibility
    /// @param solverReward Native token amount to reward the solver
    /// @param destinationCalls Optional calls to execute on destination
    struct EcoData {
        address receiverAddress;
        bytes nonEVMReceiver;
        address receivingAssetId;
        bytes32 salt;
        uint64 routeDeadline;
        address destinationPortal;
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
        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount
        );

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
        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            _ecoData.solverReward
        );

        _startBridge(_bridgeData, _ecoData);
    }

    /// Internal Methods ///

    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal {
        _validateBridgeData(_bridgeData, _ecoData);

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

    function _validateBridgeData(
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
        if (LibAsset.isNativeAsset(_bridgeData.sendingAssetId)) {
            return new IEcoPortal.TokenAmount[](0);
        }

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

        return
            IEcoPortal.Intent({
                destination: uint64(_bridgeData.destinationChainId),
                route: IEcoPortal.Route({
                    salt: _ecoData.salt,
                    deadline: _ecoData.routeDeadline,
                    portal: _ecoData.destinationPortal,
                    nativeAmount: isNative ? _bridgeData.minAmount : 0,
                    tokens: routeTokens,
                    calls: routeCalls
                }),
                reward: IEcoPortal.Reward({
                    deadline: _ecoData.rewardDeadline,
                    creator: msg.sender,
                    prover: _ecoData.prover,
                    nativeAmount: isNative
                        ? _ecoData.solverReward + _bridgeData.minAmount
                        : _ecoData.solverReward,
                    tokens: new IEcoPortal.TokenAmount[](0)
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
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(intentSource),
                _bridgeData.minAmount
            );

            intentSource.publishAndFund{ value: _ecoData.solverReward }(
                intent,
                false
            );
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
