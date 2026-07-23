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

The adapter exposes two exit pairs with different tolerances, plus fail-soft
limit views:

- **Strict pair (`deposit`/`withdraw`)** assumes a **standard ERC-4626** vault
  (deposit consumes exactly the requested assets, withdraw returns exactly the
  requested assets) over a non-fee-on-transfer asset. Both return the wrapper's
  asset balance delta and the wrapper reverts on a shortfall, catching a yield
  source that moves less than asked. It does **not** catch share-side dilution
  (a vault that consumes the full asset but credits fewer shares via an
  internal deposit fee) — measuring that cleanly is rounding-sensitive; such
  non-standard sources are unsupported and require a dedicated adapter.
- **Realizable pair (`withdrawUpTo`/`previewWithdrawUpTo`)** is the
  degraded-mode surface: it tolerates a source that charges an exit fee or
  limits withdrawal liquidity, redeeming the shares nominally worth the target
  (floor share basis, so the exiter's own shares absorb their source-side exit
  cost instead of diluting the remaining holders) and reporting whatever the
  source actually delivers, capped at the wrapper's whole position.
  `_assets == type(uint256).max` is a full-drain sentinel — realize the entire
  position rather than the floor-rounded value of a finite target, so an exit
  that empties the vault leaves no valueful residue behind it.
- **`previewWithdrawCost`** supports the wrapper's exact-out preview: it
  reports the gross position value a source consumes to deliver an exact asset
  amount (source-fee grossing, rounded up), so an exact-out exit pays its own
  exit cost via a larger share burn rather than socializing it.
- **`maxDeposit`/`maxWithdraw`** are fail-soft limit views: a reverting or
  malformed source view is reported as 0 (conservatively closed) instead of
  reverting or over-reporting, so the wrapper's EIP-4626 `max*` views never
  revert because of the source.

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

/// Max assets the yield source currently accepts from `_holder` on a deposit; 0 when unknown.
function maxDeposit(address _underlying, address _holder) external view returns (uint256 maxAssets)

/// Max assets `_holder` can currently pull out (position and source liquidity combined); 0 when unknown.
function maxWithdraw(address _underlying, address _holder) external view returns (uint256 maxAssets)

/// Assets actually receivable if `_holder` realized `_assets` right now, capped at the position.
function previewWithdrawUpTo(address _underlying, address _holder, uint256 _assets) external view returns (uint256 assets)

/// Position value consumed to deliver exactly `_assets` out of the yield source.
function previewWithdrawCost(address _underlying, uint256 _assets) external view returns (uint256 cost)

/// Realizes up to `_assets`, paying out whatever the source can actually deliver.
function withdrawUpTo(address _asset, address _underlying, uint256 _assets) external returns (uint256 withdrawn)
```

## Related contracts

- [LiFiVaultWrapperFactory](./LiFiVaultWrapperFactory.md) — approves adapters for use in deployments.
- [LiFiVaultWrapper](./LiFiVaultWrapper.md) — routes deposits/withdrawals through the adapter.
