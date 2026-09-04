# ERC4626Adapter

## Description

The first yield adapter for the LI.FI Earn Vault Wrapper subsystem. It resolves an
underlying's ERC-20 asset and routes a vault wrapper's deposits, withdrawals, and
valuation through the standard ERC-4626 interface. New yield sources are added via
new adapters implementing `IYieldAdapter`, not by changing the factory.

The adapter is **stateless** — it holds no storage, so `deposit`/`withdraw` are
safe to `delegatecall` from a wrapper (they run in the wrapper's context and act
only on their arguments). It is not intended to custody funds.

`deposit`/`withdraw` are guarded `onlyDelegateCall`: a direct call to the deployed
singleton reverts `DirectCallNotAllowed`. Without the guard a direct call would run
`forceApprove` in the adapter's own context and plant an attacker-chosen ERC-20
allowance from the shared singleton — harmless only while the adapter holds no
balance, but armable in advance and permanent. The guard enforces the
delegatecall-only invariant in code rather than relying on that convention.

## Assumptions

Assumes a **standard ERC-4626** vault (deposit consumes exactly the requested
assets, withdraw returns exactly the requested assets) over a non-fee-on-transfer
asset. `deposit`/`withdraw` return the wrapper's asset balance delta and the
wrapper reverts on a shortfall, catching a yield source that moves less than
asked. It does **not** catch share-side dilution (a vault that consumes the full
asset but credits fewer shares via an internal deposit fee); such non-standard
sources are unsupported and require a dedicated adapter. The same applies to
sources charging an **exit fee**: exits are exact-out, so a fee-on-exit source
trips the wrapper's shortfall guard on every withdrawal — unsupported until a
future release adds cost-aware exit pricing.

## Source liquidity view

`maxWithdrawableValue` is the source-liquidity signal behind the wrapper's
liquidity-aware `maxRedeem`/`maxWithdraw`: the source's `maxWithdraw` for the
holder — the assets it can honor on exit right now, already capped by both the
holder's position and current withdrawal liquidity. The wrapper always exits via
exact-asset `withdraw` (bounded by `maxWithdraw`), so this reads that axis rather
than the source's share-side `maxRedeem`, which EIP-4626 lets diverge and which
the wrapper never exercises. It equals the full position value on a source with
no active liquidity limit, and shrinks to what the source can currently honor
under a limit (an Aave-style utilization cap, a paused source).

## Source cap view

`maxDepositableValue` is the entry-side mirror: the source's `maxDeposit` for the
holder — the assets it will accept on entry right now, capped by any inflow limit
(an ERC-4626 supply cap, e.g. MetaMorpho). The wrapper always enters via
exact-asset `deposit` (bounded by `maxDeposit`), so this reads that axis rather
than the source's share-side `maxMint`. It returns `type(uint256).max` on a source
with no active cap — EIP-4626's own unlimited sentinel — which the wrapper passes
through so an uncapped source keeps reporting unbounded deposit capacity.

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

/// The source's `maxWithdraw` for the holder — the exit-liquidity signal (the wrapper exits via `withdraw`, not `redeem`).
function maxWithdrawableValue(address _underlying, address _holder) external view returns (uint256 assets)

/// The source's `maxDeposit` for the holder — the entry-cap signal; `type(uint256).max` when the source is uncapped.
function maxDepositableValue(address _underlying, address _holder) external view returns (uint256 assets)
```

## Related contracts

- [LiFiVaultWrapperFactory](./LiFiVaultWrapperFactory.md) — approves adapters for use in deployments.
- [LiFiVaultWrapper](./LiFiVaultWrapper.md) — routes deposits/withdrawals through the adapter.
