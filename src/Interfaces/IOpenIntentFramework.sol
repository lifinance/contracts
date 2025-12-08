// SPDX-License-Identifier: LGPL-3.0-only

pragma solidity ^0.8.17;

/// @title IOpenIntentFramework
/// @notice Data structures for the Open Intent Framework used by LiFi Intent Escrow
/// @author LI.FI (https://li.fi)
/// @custom:version 1.0.0

/// @notice Defines the output mandate for cross-chain settlement
/// @dev Contains all necessary information to settle an order on the destination chain
/// @param oracle Oracle implementation responsible for collecting the proof from settler on output chain
/// @param settler Output Settler on the output chain responsible for settling the output payment
/// @param chainId The destination chain ID where the output will be settled
/// @param token The token address on the destination chain
/// @param amount The amount of tokens to be delivered
/// @param recipient The recipient address on the destination chain
/// @param callbackData Data that will be delivered to recipient through the settlement callback on the output chain. Can be used to schedule additional actions
/// @param context Additional output context for the output settlement, encoding order types or other information
struct MandateOutput {
    bytes32 oracle;
    bytes32 settler;
    uint256 chainId;
    bytes32 token;
    uint256 amount;
    bytes32 recipient;
    bytes callbackData;
    bytes context;
}

/// @notice Defines a standard order for the Open Intent Framework
/// @dev Contains all information needed to create and process an intent order
/// @param user The address that created the order and will receive refunds
/// @param nonce Unique nonce to prevent replay attacks
/// @param originChainId The chain ID where the order was created
/// @param expires Timestamp after which the order expires and can no longer be filled
/// @param fillDeadline Timestamp by which the order must be filled
/// @param inputOracle Address of the validation layer used on the input chain
/// @param inputs Array of input token amounts, each element is [tokenId, amount]
/// @param outputs Array of output mandates defining what should be delivered on destination chains
struct StandardOrder {
    address user;
    uint256 nonce;
    uint256 originChainId;
    uint32 expires;
    uint32 fillDeadline;
    address inputOracle;
    uint256[2][] inputs;
    MandateOutput[] outputs;
}
