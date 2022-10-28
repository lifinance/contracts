# Executor

## Description

Periphery contract used for aribitrary cross-chain and same chain execution, swaps and transfers

## How To Use

The contract has a number of methods that can be called depending on the context of the transaction
and which third-party integration is being used.

The following methods are available:

This method is used to execute transactions received by the Stargate Router

```solidity
/// @notice Completes a cross-chain transaction on the receiving chain.
/// @dev This function is called from Stargate Router.
/// @param * (unused) The remote chainId sending the tokens
/// @param * (unused) The remote Bridge address
/// @param * (unused) Nonce
/// @param * (unused) The token contract on the local chain
/// @param * (unused) The amount of local _token contract tokens
/// @param _payload The data to execute
function sgReceive(
    uint16, // _srcChainId unused
    bytes memory, // _srcAddress unused
    uint256, // _nonce unused
    address _token,
    uint256 _amountLD,
    bytes memory _payload
)
```

This method is used to execute transactions via post call.

```solidity
/// @notice Performs a swap before completing a cross-chain transaction
/// @param _transactionId the transaction id associated with the operation
/// @param _swapData array of data needed for swaps
/// @param assetId token received from the other chain
/// @param receiver address that will receive tokens in the end
function swapAndCompleteBridgeTokens(
    bytes32 _transactionId,
    LibSwap.SwapData[] memory _swapData,
    address assetId,
    address payable receiver
)
```

This method is used to send remaining tokens to receiver.

```solidity
/// @notice Send remaining token to receiver
/// @param assetId token received from the other chain
/// @param receiver address that will receive tokens in the end
/// @param amount amount of token
function pullToken(
    address assetId,
    address payable receiver,
    uint256 amount
)
```

The contract also has a number of utility methods that are self-explanatory

```solidity
/// @notice set Stargate Router
/// @param _router the Stargate router address
function setStargateRouter(address _router)
```
