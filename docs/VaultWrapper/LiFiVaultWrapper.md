# LiFiVaultWrapper

## Description

The per-integrator-product ERC-4626 vault of the LI.FI Earn Vault Wrapper
subsystem. Shares represent a claim on the assets the wrapper holds in an
underlying yield source; deposits are forwarded to the source and withdrawals are
redeemed from it, both routed through an approved `IYieldAdapter`.

Each instance is deployed by [LiFiVaultWrapperFactory](./LiFiVaultWrapperFactory.md)
as an OpenZeppelin `BeaconProxy` and configured once via `initialize`. The
subsystem builds on OpenZeppelin v5.

This contract **does custody funds**: it holds the yield-source position on behalf
of depositors and transiently holds the asset while routing a deposit or
withdrawal.

## Key Features

- Standard ERC-4626 vault surface (`deposit`/`mint`/`withdraw`/`redeem`) plus
  EIP-5143 slippage-bounded overloads.
- Four fee types — performance (high-water-mark), management (time-based),
  deposit, and withdrawal — each split between LI.FI and the integrator at accrual
  time. `distributeFees` is permissionless and pays LI.FI's parts to the factory's
  live `lifiFeeRecipient` and the integrator's parts across its receiver wallets.
- Inflation-attack protection: a per-instance ERC-4626 virtual-share decimals
  offset derived at `initialize` (floored at a nonzero minimum) plus a deposit-side
  supply floor.
- A single pluggable `IAccessGate` (zero = permissionless) enforced fail-closed on
  entry, share transfers, and exits.
- Pause is enforced on the deposit/mint path only; withdrawals stay open.

## Admin role

The per-vault admin is OZ's two-step `owner`
(`transferOwnership` / `acceptOwnership`). `renounceOwnership` is disabled — a
custody contract must never be left ownerless.

## Initialization

`initialize` is called once by the factory immediately after the proxy is
deployed. It sets the identity (`underlying` / `adapter` / `owner` / `factory`),
the initial fee configuration, receivers, and access gate; resolves the ERC-20
asset via the adapter; derives the virtual-share offset from the asset decimals;
and anchors the performance watermark at the empty-vault share price.

## Fee config getters

```solidity
/// Configured rate (bps) for a fee type (ordinal 0-3).
function feeRate(uint8 _feeType) external view returns (uint16)

/// Whether a fee type is enabled (a non-zero rate is the enabled flag).
function feeEnabled(uint8 _feeType) external view returns (bool)
```

## Related contracts

- [LiFiVaultWrapperFactory](./LiFiVaultWrapperFactory.md) — deploys and configures instances.
- [ERC4626Adapter](./ERC4626Adapter.md) — the first yield adapter.
