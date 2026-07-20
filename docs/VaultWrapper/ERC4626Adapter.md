# ERC4626Adapter

## Description

The first yield adapter for the LI.FI Earn Vault Wrapper subsystem. It resolves an
underlying's ERC-20 asset and routes a vault wrapper's deposits, withdrawals, and
valuation through the standard ERC-4626 interface. New yield sources are added via
new adapters implementing `IYieldAdapter`, not by changing the factory.

The adapter is **stateless** — it holds no storage, so `deposit`/`withdraw` are
safe to `delegatecall` from a wrapper (they run in the wrapper's context and act
only on their arguments). It is not intended to custody funds.

## Assumptions

Assumes a **standard ERC-4626** vault (deposit consumes exactly the requested
assets, withdraw returns exactly the requested assets) over a non-fee-on-transfer
asset. `deposit`/`withdraw` return the wrapper's asset balance delta and the
wrapper reverts on a shortfall, catching a yield source that moves less than
asked. It does **not** catch share-side dilution (a vault that consumes the full
asset but credits fewer shares via an internal deposit fee); such non-standard
sources are unsupported and require a dedicated adapter.

## Functions

```solidity
/// Resolve the ERC-20 asset an ERC-4626 vault is denominated in.
function resolveAsset(address _underlying) external view returns (address asset)

/// Assets currently redeemable by `_holder` from the yield source.
function totalAssets(address _underlying, address _holder) external view returns (uint256 assets)

/// Forward `_assets` into the yield source; returns the asset amount consumed.
function deposit(address _asset, address _underlying, uint256 _assets) external returns (uint256 deposited)

/// Redeem `_assets` from the yield source; returns the asset amount received.
function withdraw(address _asset, address _underlying, uint256 _assets) external returns (uint256 withdrawn)
```

## Related contracts

- [LiFiVaultWrapperFactory](./LiFiVaultWrapperFactory.md) — approves adapters for use in deployments.
- [LiFiVaultWrapper](./LiFiVaultWrapper.md) — routes deposits/withdrawals through the adapter.
