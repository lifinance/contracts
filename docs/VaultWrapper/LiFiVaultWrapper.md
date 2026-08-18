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
- The exit `max*` views are source-liquidity-aware — see
  [Exit semantics](#exit-semantics).

## Exit semantics

- `maxRedeem` clamps the owner's balance to what the source can currently honor
  (via the adapter's `maxWithdrawableValue`), with a full-position short-circuit
  so it equals `balanceOf` on a fully-liquid source and only clamps when the
  source is genuinely liquidity-limited (an Aave-style utilization cap, a paused
  source). `maxWithdraw` inherits the clamp because OZ derives it as
  `previewRedeem(maxRedeem(owner))`, so both exit entrypoints' `ERC4626Exceeded*`
  guards are liquidity-aware and an exit within the reported max never reverts on
  a source liquidity limit (the EIP-4626 guarantee).
- Because `maxRedeem` consults the source's views, it reverts if those views
  revert (a bricked source). This is fail-closed by design, consistent with the
  gate-checked views, and a deliberate deviation from EIP-4626's expectation that
  `max*` views never revert.
- `previewRedeem`/`previewWithdraw` remain **liquidity-agnostic**: EIP-4626
  requires previews to ignore withdrawal limits, so they value against the full
  position and never consult `maxWithdrawableValue`.
- Dust tradeoff on OZ-derived sources (e.g. MetaMorpho, whose own `maxRedeem`
  floors ~1 source share below `balanceOf` even at full liquidity): a one-call
  full exit via `redeem(balanceOf)` may hit `ERC4626ExceededMaxRedeem`. Callers
  should exit via `redeem(maxRedeem(owner))`, which may leave residual dust —
  bounded by one source share's value — that a follow-up call clears.
- Sources that charge an exit fee (or pay out less than their reported value)
  are **unsupported**: exits are exact-out and the wrapper reverts
  `AdapterWithdrawShortfall` on a short-paying source, so onboarding such a
  source freezes its exits rather than mispricing them. Cost-aware exit pricing
  is deferred to a future release (instances are beacon-upgradeable; a
  fee-charging source would also need a dedicated adapter).
- The exact-out `withdraw` right at `maxWithdraw` sits on a known rounding
  boundary: with a nonzero withdrawal fee, re-grossing the requested net amount
  can land a wei past a source's exact liquidity cap — the one tolerated
  artifact. `redeem` has no such boundary and is the guaranteed exit.

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

## Upgradeability and the FACTORY binding

Instances are `BeaconProxy` contracts; the `UpgradeableBeacon` is owned by the
subsystem's 48h timelock, so a `upgradeTo` repoints every live instance to a new
implementation at once. `FACTORY` is an **implementation immutable** (bytecode, not
proxy storage), and it is the source every instance reads for the factory-level
global circuit breaker (`globalPaused`), fee bounds, and `lifiFeeRecipient`, as well
as the `initialize` caller check.

Because that reference lives in implementation bytecode rather than per-instance
storage, a beacon upgrade to an implementation constructed with a **different**
factory address silently repoints all live instances' config authority — for
example flipping `globalPaused` to `false` across every wrapper — with no
per-instance migration or event beyond the beacon's generic `Upgraded`.

Operational invariant: every implementation the beacon points to must be
constructed with the same factory address. Upgrade tooling must assert
`newImpl.FACTORY() == oldImpl.FACTORY()` before repointing the beacon (mirroring the
deploy script's `_verifyWiring` check), and the change is only reachable through the
48h timelock, which can already replace the implementation with arbitrary logic.

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
