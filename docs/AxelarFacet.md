# Axelar Facet

## Description

Enables cross-chain messaging and contract execution using the Axelar Network

## How To Use

The contract allows you to make arbitrary cross-chain calls. These calls can be made with or without sending a token as part of the call.

The contract encodes an address and a calldata payload to be called by an executor contract on the receiving chain.

You can make calls using the following methods

Without tokens

```solidity
/// @notice Initiates a cross-chain contract call via Axelar Network
/// @param destinationChain the chain to execute on
/// @param destinationAddress the address of the LiFi contract on the destinationChain
/// @param callTo the address of the contract to call
/// @param callData the encoded calldata for the contract call
function executeCallViaAxelar(
    string memory destinationChain,
    string memory destinationAddress,
    address callTo,
    bytes calldata callData
)
```

With tokens

```solidity
/// @notice Initiates a cross-chain contract call while sending a token via Axelar Network
/// @param destinationChain the chain to execute on
/// @param destinationAddress the address of the LiFi contract on the destinationChain
/// @param symbol the symbol of the token to send with the transaction
/// @param amount the amount of tokens to send
/// @param callTo the address of the contract to call
/// @param callData the encoded calldata for the contract call
function executeCallWithTokenViaAxelar(
    string memory destinationChain,
    string memory destinationAddress,
    string memory symbol,
    uint256 amount,
    address callTo,
    bytes calldata callData
)
```
