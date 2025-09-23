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
import { IERC20 } from "lib/openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
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
        _validateEcoData(_bridgeData, _ecoData);

        // For ERC20, deposit includes the solver reward
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
        _validateEcoData(_bridgeData, _ecoData);

        // Reserve native fee if the final asset is native
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

        // For ERC20, subtract solver reward from swap result to get bridge amount
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
        if (_lifiChainId == LIFI_CHAIN_ID_TRON) {
            return ECO_CHAIN_ID_TRON;
        }
        if (_lifiChainId == LIFI_CHAIN_ID_SOLANA) {
            return ECO_CHAIN_ID_SOLANA;
        }

        // Ensure chain ID fits within uint64
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
        bool isNative = LibAsset.isNativeAsset(_bridgeData.sendingAssetId);
        uint256 totalAmount = _bridgeData.minAmount + _ecoData.solverReward;

        IEcoPortal.Reward memory reward = _buildReward(
            _bridgeData,
            _ecoData,
            isNative,
            totalAmount
        );

        uint64 destination = _getEcoChainId(_bridgeData.destinationChainId);

        if (!isNative) {
            LibAsset.maxApproveERC20(
                IERC20(_bridgeData.sendingAssetId),
                address(PORTAL),
                totalAmount
            );
        }

        PORTAL.publishAndFund{ value: isNative ? totalAmount : 0 }(
            destination,
            _ecoData.encodedRoute,
            reward,
            false
        );

        _emitEvents(_bridgeData, _ecoData);
    }

    function _validateEcoData(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private pure {
        if (_ecoData.encodedRoute.length == 0) {
            revert InvalidConfig();
        }
        if (
            _bridgeData.receiver == NON_EVM_ADDRESS &&
            _ecoData.nonEVMReceiver.length == 0
        ) {
            revert InvalidReceiver();
        }
        if (
            _bridgeData.receiver != NON_EVM_ADDRESS &&
            _bridgeData.receiver != _ecoData.receiverAddress
        ) {
            revert InformationMismatch();
        }

        _validateRouteReceiver(_bridgeData, _ecoData);
    }

    function _validateRouteReceiver(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private pure {
        if (_bridgeData.receiver == NON_EVM_ADDRESS) {
            if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_SOLANA) {
                _validateSolanaReceiver(_ecoData);
            }
            return;
        }
        if (_isEVMChain(_bridgeData.destinationChainId)) {
            address decodedReceiver = _extractEVMReceiverFromRoute(
                _ecoData.encodedRoute
            );

            if (decodedReceiver != _bridgeData.receiver) {
                revert InformationMismatch();
            }
        }
    }

    function _validateSolanaReceiver(EcoData calldata _ecoData) private pure {
        // Extract the Solana recipient address from a Borsh-encoded Route struct
        // The Route struct contains TransferChecked instruction calldata where:
        // - The entire Route struct is Borsh-serialized
        // - Within the serialized Route, the TransferChecked instruction data is embedded
        // - The recipient account (destination wallet) is located at bytes 251-282 (32 bytes)
        // - This position is determined by the Route struct layout and the position of the
        //   recipient pubkey within the TransferChecked instruction calldata
        // - Borsh encoding preserves the exact byte positions for fixed-size fields like pubkeys
        // - The total encoded route for Solana must be exactly 319 bytes
        if (_ecoData.encodedRoute.length != 319) {
            revert InvalidCallData();
        }

        // Extract bytes 251-282 (32 bytes) which contain the recipient address
        bytes32 routeReceiver = bytes32(_ecoData.encodedRoute[251:283]);
        if (
            _ecoData.nonEVMReceiver.length == 0 ||
            _ecoData.nonEVMReceiver.length > 44
        ) {
            revert InvalidReceiver();
        }
        if (routeReceiver == bytes32(0)) {
            revert InvalidReceiver();
        }
    }

    function _extractEVMReceiverFromRoute(
        bytes calldata encodedRoute
    ) internal pure returns (address) {
        uint256 routeLength = encodedRoute.length;
        if (routeLength < 68) {
            revert InvalidCallData();
        }

        uint256 transferOffset = routeLength - 68;
        bytes4 selector = bytes4(
            encodedRoute[transferOffset:transferOffset + 4]
        );
        if (selector != bytes4(0xa9059cbb)) {
            revert InvalidCallData();
        }
        return
            address(
                uint160(
                    bytes20(
                        encodedRoute[transferOffset + 16:transferOffset + 36]
                    )
                )
            );
    }

    function _isEVMChain(uint256 chainId) private pure returns (bool) {
        if (chainId == LIFI_CHAIN_ID_SOLANA) {
            return false;
        }
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
