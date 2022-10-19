# Executor

## Description

Periphery contract used for aribitrary cross-chain and same chain execution, swaps and transfers

## How To Use

The contract has a number of methods that can be called depending on the context of the transaction
and which third-party integration is being used.

The following methods are available:

This method is used to execute transactions received by Connext

```solidity
/// @notice Performs a swap before completing a cross-chain transaction
/// @param _transactionId the transaction id for the swap
/// @param _swapData array of data needed for swaps
/// @param _transferredAssetId token received from the other chain
/// @param _receiver address that will receive tokens in the end
function swapAndCompleteBridgeTokens(
    bytes32 _transactionId,
    LibSwap.SwapData[] calldata _swapData,
    address _transferredAssetId,
    address payable _receiver
)
```

This method is meant to be called as part of a single chain transaction. It allows
a user to make any number of swaps or arbitrary contract calls.

```solidity
/// @notice Performs a series of swaps or arbitrary executions
/// @param _transactionId the transaction id for the swap
/// @param _swapData array of data needed for swaps
/// @param _transferredAssetId token received from the other chain
/// @param _receiver address that will receive tokens in the end
/// @param _amount amount of token for swaps or arbitrary executions
function swapAndExecute(
    bytes32 _transactionId,
    LibSwap.SwapData[] calldata _swapData,
    address _transferredAssetId,
    address payable _receiver,
    uint256 _amount
)
```

The contract also has a number of utility methods that are self-explanatory

```solidity
/// @notice set ERC20 Proxy
/// @param _erc20Proxy the address of the ERC20Proxy contract
function setERC20Proxy(address _erc20Proxy)
```
