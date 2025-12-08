# Blast Gas Fee Collector Facet

## Description

A facet that provides functionality for configuring and claiming gas fees on the Blast network. The contract interacts with the Blast precompile to enable claimable gas mode and retrieve accumulated gas fees.

## How To Use

The Blast Gas Fee Collector Facet allows the contract owner to configure the contract to accumulate gas fees and claim them to a specified recipient address.

### Configuring Gas Mode

First, configure the contract to use claimable gas mode. This enables the contract to accumulate gas fees over time.

```solidity
/// @notice Configures the contract to use claimable gas mode
/// @dev This enables the contract to accumulate gas fees. Can be called multiple times safely.
function configureGasMode() external
```

### Claiming Gas Fees

Once gas fees have accumulated, they can be claimed and sent to a specified recipient address.

```solidity
/// @notice Claims all accumulated gas fees and sends them to the specified recipient
/// @param recipient The address that will receive the claimed gas fees
function claimGasFees(address recipient) external
```

## Notes

- Both `configureGasMode()` and `claimGasFees()` can only be called by the contract owner
- The recipient address must not be the zero address when claiming gas fees
- The contract must be configured with claimable gas mode before fees can accumulate
- `configureGasMode()` can be called multiple times safely (idempotent)
