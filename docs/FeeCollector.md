# FeeCollector

## Description

Periphery contract used for fee collection and retrieval.

## How To Use

The contract is meant to be used as part of a batch of transactions run in the swap step of a LIFI
bridging transaction.

There are two fee collection methods.
One for ERC20 tokens

```solidity
/// @notice Collects fees for the integrator
/// @param tokenAddress address of the token to collect fees for
/// @param integratorFee amount of fees to collect going to the integrator
/// @param lifiFee amount of fees to collect going to lifi
/// @param integratorAddress address of the integrator
function collectTokenFees(
    address tokenAddress,
    uint256 integratorFee,
    uint256 lifiFee,
    address integratorAddress
)
```

and another for Native tokens (e.g. ETH, MATIC, XDAI)

```solidity
/// @notice Collects fees for the integrator in native token
/// @param integratorFee amount of fees to collect going to the integrator
/// @param lifiFee amount of fees to collect going to lifi
/// @param integratorAddress address of the integrator
function collectNativeFees(
    uint256 integratorFee,
    uint256 lifiFee,
    address integratorAddress
)
```

Integrators can withdraw their fees using the following methods

```solidity
/// @notice Withdraw fees and sends to the integrator
/// @param tokenAddress address of the token to withdraw fees for
function withdrawIntegratorFees(address tokenAddress)

/// @notice Batch withdraw fees and sends to the integrator
/// @param tokenAddresses addresses of the tokens to withdraw fees for
function batchWithdrawIntegratorFees(address[] memory tokenAddresses)
```

LIFI can withdraw fees using the following methods

```solidity
/// @notice Withdraws fees and sends to lifi
/// @param tokenAddress address of the token to withdraw fees for
function withdrawLifiFees(address tokenAddress)

/// @notice Batch withdraws fees and sends to lifi
/// @param tokenAddresses addresses of the tokens to withdraw fees for
function batchWithdrawLifiFees(address[] memory tokenAddresses)
```
