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

## Exit cost views

Three methods give the wrapper cost-aware and loss-tolerant exits without
assuming anything about the source beyond its own standard EIP-4626 previews:

- `previewWithdrawCost` — the exact-out cost: the position value the source
  consumes to deliver exactly `assets` out (`>= assets` when the source charges
  an exit fee). Backs the wrapper's cost-aware `previewWithdraw`, so an exiting
  holder's share burn is priced off the source's true exit cost instead of
  diluting remaining holders.
- `previewWithdrawUpTo` — the exact-in realizable amount: what the source would
  deliver if the holder realizes up to `assets` of position value now, capped
  at the holder's position, net of any source exit fee. It is the static
  mirror of `withdrawUpTo` and backs the wrapper's realizable `previewRedeem`.
- `withdrawUpTo` — the exact-in execution. DELEGATECALL only; realizes up to
  `assets` of position value into the wrapper and returns the measured asset
  delta. Backs `redeem`.
- `maxWithdrawableValue` — the source-liquidity signal: the floor valuation
  (`convertToAssets`) of the GROSS worth of `min(holder position, source.maxRedeem)`.
  Gross by design (not `previewRedeem`) — it does NOT net the source's exit fee, because
  the wrapper feeds it into its own gross share math to clamp its `max*` views to what the
  source can currently honor. Equals the full position value on a fully-liquid source (one
  with no active liquidity limit).

These views read cost/realizable amounts straight from the source's own
EIP-4626 `previewWithdraw`/`previewRedeem`, so they carry the same
standard-source assumption as the rest of the adapter: a non-compliant or
fee-on-transfer source is unsupported and needs a dedicated adapter.

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

/// Position value the source consumes to deliver exactly `_assets` out (exact-out cost).
function previewWithdrawCost(address _underlying, uint256 _assets) external view returns (uint256 cost)

/// Assets delivered if `_holder` realizes up to `_assets` of position value now (exact-in preview).
function previewWithdrawUpTo(address _underlying, address _holder, uint256 _assets) external view returns (uint256 delivered)

/// Realizes up to `_assets` of position value from the source; returns the measured asset delta.
function withdrawUpTo(address _asset, address _underlying, uint256 _assets) external returns (uint256 withdrawn)

/// Gross floor valuation of `min(holder position, source.maxRedeem)` — the source-liquidity signal (not exit-fee-netted).
function maxWithdrawableValue(address _underlying, address _holder) external view returns (uint256 assets)
```

## Related contracts

- [LiFiVaultWrapperFactory](./LiFiVaultWrapperFactory.md) — approves adapters for use in deployments.
- [LiFiVaultWrapper](./LiFiVaultWrapper.md) — routes deposits/withdrawals through the adapter.
