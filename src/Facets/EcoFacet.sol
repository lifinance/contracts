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
import { InvalidConfig, InvalidReceiver, InformationMismatch } from "../Errors/GenericErrors.sol";

/// @title EcoFacet
/// @author LI.FI (https://li.fi)
/// @notice Provides functionality for bridging through Eco Protocol
/// @custom:version 1.0.0
contract EcoFacet is ILiFi, ReentrancyGuard, SwapperV2, Validatable, LiFiData {
    /// Storage ///

    IEcoPortal public immutable PORTAL;
    uint64 private immutable ECO_CHAIN_ID_TRON = 728126428;
    uint64 private immutable ECO_CHAIN_ID_SOLANA = 1399811149;

    /// Constants ///

    uint256 private constant NATIVE_REWARD_AMOUNT = 0;
    bool private constant ALLOW_PARTIAL_FILL = false;
    uint256 private constant SOLANA_ENCODED_ROUTE_LENGTH = 319;
    uint256 private constant SOLANA_RECEIVER_OFFSET = 251;
    uint256 private constant SOLANA_RECEIVER_END = 283;
    uint256 private constant SOLANA_ADDRESS_MIN_LENGTH = 32;
    uint256 private constant SOLANA_ADDRESS_MAX_LENGTH = 44;

    /// Types ///

    /// @notice Defines the routing and execution instructions for cross-chain messages
    /// @dev Contains all necessary information to route and execute a message on the destination chain
    /// @param salt Unique identifier provided by the intent creator, used to prevent duplicates
    /// @param deadline Timestamp by which the route must be executed
    /// @param portal Address of the portal contract on the destination chain that receives messages
    /// @param nativeAmount Amount of native tokens to send with the route execution
    /// @param tokens Array of tokens required for execution of calls on destination chain
    /// @param calls Array of contract calls to execute on the destination chain in sequence
    struct Route {
        bytes32 salt;
        uint64 deadline;
        address portal;
        uint256 nativeAmount;
        IEcoPortal.TokenAmount[] tokens;
        Call[] calls;
    }

    /// @notice Represents a single contract call to be executed
    /// @dev Used within Route to define execution sequence
    /// @param target Address of the contract to call
    /// @param callData Encoded function call data
    struct Call {
        address target;
        bytes callData;
    }

    /// @dev Eco specific parameters
    /// @param receiverAddress Address that will receive tokens on destination chain
    /// @param nonEVMReceiver Destination address for non-EVM chains (bytes format)
    /// @param prover Address of the prover contract for validation
    /// @param rewardDeadline Timestamp for reward claim eligibility
    /// @param solverReward Reward amount for the solver (native or ERC20 depending on sendingAssetId)
    /// @param encodedRoute Encoded route data containing destination chain routing information
    /// @param solanaATA Associated Token Account address for Solana bridging (bytes32)
    struct EcoData {
        address receiverAddress;
        bytes nonEVMReceiver;
        address prover;
        uint64 rewardDeadline;
        uint256 solverReward;
        bytes encodedRoute;
        bytes32 solanaATA;
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
        nonReentrant
        validateBridgeData(_bridgeData)
        doesNotContainSourceSwaps(_bridgeData)
        doesNotContainDestinationCalls(_bridgeData)
        noNativeAsset(_bridgeData)
    {
        _validateEcoData(_bridgeData, _ecoData);

        LibAsset.depositAsset(
            _bridgeData.sendingAssetId,
            _bridgeData.minAmount + _ecoData.solverReward
        );

        _startBridge(_bridgeData, _ecoData);
    }

    /// @notice Swaps and bridges tokens via Eco Protocol
    /// @param _bridgeData Bridge data containing core parameters
    /// @param _swapData Array of swap data for source swaps
    /// @param _ecoData Eco-specific parameters for the bridge
    /// @dev IMPORTANT LIMITATION: For ERC20 tokens, positive slippage from pre-bridge swaps
    /// may remain in the diamond contract. The intent amount is encoded in encodedRoute
    /// (provided by Eco API), and the Portal only transfers the exact reward amount specified.
    /// If swaps produce more tokens than expected (positive slippage), only the amount specified
    /// in the reward struct (bridgeAmount + solverReward) is transferred to the Portal vault.
    /// Any excess remains in the diamond. This is a known limitation that can be significant
    /// when bridging large amounts. Native tokens handle positive slippage correctly by sending
    /// additional value with the transaction.
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
        noNativeAsset(_bridgeData)
    {
        _validateEcoData(_bridgeData, _ecoData);

        _bridgeData.minAmount = _depositAndSwap(
            _bridgeData.transactionId,
            _bridgeData.minAmount,
            _swapData,
            payable(msg.sender),
            0
        );

        // Subtract solver reward from swap result to get bridge amount
        _bridgeData.minAmount = _bridgeData.minAmount - _ecoData.solverReward;

        _startBridge(_bridgeData, _ecoData);
    }

    /// Internal Methods ///

    function _buildReward(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData,
        uint256 totalAmount
    ) private view returns (IEcoPortal.Reward memory) {
        IEcoPortal.TokenAmount[]
            memory rewardTokens = new IEcoPortal.TokenAmount[](1);
        rewardTokens[0] = IEcoPortal.TokenAmount({
            token: _bridgeData.sendingAssetId,
            amount: totalAmount
        });

        return
            IEcoPortal.Reward({
                creator: msg.sender,
                prover: _ecoData.prover,
                deadline: _ecoData.rewardDeadline,
                nativeAmount: NATIVE_REWARD_AMOUNT,
                tokens: rewardTokens
            });
    }

    function _startBridge(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) internal {
        uint256 totalAmount = _bridgeData.minAmount + _ecoData.solverReward;

        IEcoPortal.Reward memory reward = _buildReward(
            _bridgeData,
            _ecoData,
            totalAmount
        );

        uint64 destination;
        if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_TRON) {
            destination = ECO_CHAIN_ID_TRON;
        } else if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_SOLANA) {
            destination = ECO_CHAIN_ID_SOLANA;
        } else {
            if (_bridgeData.destinationChainId > type(uint64).max) {
                revert InvalidConfig();
            }
            destination = uint64(_bridgeData.destinationChainId);
        }

        LibAsset.maxApproveERC20(
            IERC20(_bridgeData.sendingAssetId),
            address(PORTAL),
            totalAmount
        );

        PORTAL.publishAndFund(
            destination,
            _ecoData.encodedRoute,
            reward,
            ALLOW_PARTIAL_FILL
        );

        if (_bridgeData.destinationChainId == LIFI_CHAIN_ID_SOLANA) {
            emit BridgeToNonEVMChain(
                _bridgeData.transactionId,
                _bridgeData.destinationChainId,
                _ecoData.nonEVMReceiver
            );
        }

        emit LiFiTransferStarted(_bridgeData);
    }

    function _validateEcoData(
        ILiFi.BridgeData memory _bridgeData,
        EcoData calldata _ecoData
    ) private view {
        if (_ecoData.prover == address(0)) revert InvalidConfig();
        if (
            _ecoData.rewardDeadline == 0 ||
            _ecoData.rewardDeadline <= block.timestamp
        ) {
            revert InvalidConfig();
        }

        address receiver = _bridgeData.receiver;
        bool isSolanaDestination = _bridgeData.destinationChainId ==
            LIFI_CHAIN_ID_SOLANA;

        if (receiver == NON_EVM_ADDRESS) {
            if (!isSolanaDestination) {
                revert InvalidConfig();
            }

            if (_ecoData.nonEVMReceiver.length == 0) revert InvalidReceiver();
            if (_ecoData.solanaATA == bytes32(0)) revert InvalidConfig();
            if (_ecoData.encodedRoute.length != SOLANA_ENCODED_ROUTE_LENGTH)
                revert InvalidReceiver();
            _validateSolanaReceiver(_ecoData);
        } else {
            if (receiver != _ecoData.receiverAddress)
                revert InformationMismatch();
            if (_ecoData.encodedRoute.length == 0) revert InvalidConfig();

            // If receiver is not NON_EVM_ADDRESS but destination is Solana, reject
            if (isSolanaDestination) {
                revert InvalidReceiver();
            }

            // For EVM-compatible chains (includes TRON), decode the Route struct to get the last call
            // Note: TRON is considered EVM-compatible here as it uses the same Route struct encoding
            Route memory route = abi.decode(_ecoData.encodedRoute, (Route));

            // The last call should be the transfer to the receiver
            // For ERC20 transfer, the calldata follows the pattern: transfer(address,uint256)
            // We need to skip the function selector (4 bytes) and decode the address parameter
            bytes memory lastCallData = route
                .calls[route.calls.length - 1]
                .callData;

            // Extract the receiver address from the calldata
            // Skip the 4-byte function selector and decode the address (first parameter)
            // The address parameter starts at byte 4 (after the selector)
            address routeReceiver;
            assembly {
                // Load the address from offset 36 (32 bytes length + 4 bytes selector)
                routeReceiver := mload(add(lastCallData, 36))
            }

            if (routeReceiver != _bridgeData.receiver) {
                revert InvalidReceiver();
            }
        }
    }

    function _validateSolanaReceiver(EcoData calldata _ecoData) private pure {
        // Validate the nonEVMReceiver length for Solana addresses
        // Solana addresses are base58-encoded and should be between 32-44 characters
        if (
            _ecoData.nonEVMReceiver.length < SOLANA_ADDRESS_MIN_LENGTH ||
            _ecoData.nonEVMReceiver.length > SOLANA_ADDRESS_MAX_LENGTH
        ) {
            revert InvalidReceiver();
        }

        // Extract the Solana recipient address from a Borsh-encoded Route struct
        // The Route struct contains TransferChecked instruction calldata where:
        // - The entire Route struct is Borsh-serialized
        // - Within the serialized Route, the TransferChecked instruction data is embedded
        // - The recipient account (destination wallet) is located at bytes 251-282 (32 bytes)
        // - This position is determined by the Route struct layout and the position of the
        //   recipient pubkey within the TransferChecked instruction calldata
        // - Borsh encoding preserves the exact byte positions for fixed-size fields like pubkeys
        // - The total encoded route for Solana must be exactly 319 bytes
        // Extract bytes 251-282 (32 bytes) which contain the recipient address
        bytes32 routeReceiver = bytes32(
            _ecoData.encodedRoute[SOLANA_RECEIVER_OFFSET:SOLANA_RECEIVER_END]
        );

        // Validate that the provided solanaATA matches the recipient in the encoded route
        if (_ecoData.solanaATA != routeReceiver) {
            revert InvalidReceiver();
        }
    }
}
