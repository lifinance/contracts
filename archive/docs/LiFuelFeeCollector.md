# LiFuelFeeCollector

## Description

Periphery contract used for fee collection and retrieval for LiFuel.

## How To Use

The contract is meant to be used as part of a batch of transactions run in the swap step of a LIFI
bridging transaction.

There are two fee collection methods:

One for ERC20 tokens

```solidity
  /// @notice Collects gas fees
  /// @param tokenAddress The address of the token to collect
  /// @param feeAmount The amount of fees to collect
  /// @param chainId The chain id of the destination chain
  /// @param receiver The address to send gas to on the destination chain
  function collectTokenGasFees(
    address tokenAddress,
    uint256 feeAmount,
    uint256 chainId,
    address receiver
)
```

and another for Native tokens (e.g. ETH, MATIC, XDAI)

```solidity
  /// @notice Collects gas fees in native token
  /// @param chainId The chain id of the destination chain
  /// @param receiver The address to send gas to on destination chain
  function collectNativeGasFees(
    uint256 chainId,
    address receiver
)
```

LIFI can withdraw fees using the following methods

```solidity
  /// @notice Withdraws fees
  /// @param tokenAddress The address of the token to withdraw fees for
  function withdrawFees(address tokenAddress)

  /// @notice Batch withdraws fees
  /// @param tokenAddresses The addresses of the tokens to withdraw fees for
  function batchWithdrawFees(
    address[] calldata tokenAddresses
  )
```
