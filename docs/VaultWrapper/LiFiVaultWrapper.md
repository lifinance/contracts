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
- Exits are cost-aware: the exiting caller bears the yield source's exit cost
  (fee or realized loss), never remaining holders — see
  [Exit semantics](#exit-semantics).

## Exit semantics

- `withdraw` is **exact-out and cost-aware**: the exiter's share burn is priced
  off the source's true exit cost (`previewWithdrawCost`), so a source exit fee
  falls on the exiter rather than diluting remaining holders. On a fee source,
  `maxWithdraw` reports the fee-adjusted net amount, so requesting the full
  nominal deposit exceeds it and reverts `ERC4626ExceededMaxWithdraw` —
  `redeem` is the guaranteed full exit.
- `redeem` is **exact-in and loss-tolerant**: it realizes the burned shares'
  proportional slice via the adapter's `withdrawUpTo` and pays out what the
  source actually delivered, net of the wrapper's withdrawal fee (charged on
  the actual proceeds). A source exit fee or a loss reduces the exiting
  caller's payout — it never dilutes remaining holders and never bricks the
  last exit. It always floor-values (`_convertToAssets(shares, Floor)`) and
  never drains the raw source position, so a full exit leaves the tiny
  virtual-offset residue behind — that residue is the inflation-attack buffer,
  matching standard OZ behavior.
- The `max*`/preview views are **source-liquidity-aware**: `maxRedeem` clamps the
  owner's balance to what the source can currently honor (via the adapter's
  `maxWithdrawableValue`), with a full-position short-circuit so it equals `balanceOf`
  on a fully-liquid source and only clamps when the source is genuinely
  liquidity-limited (an Aave-style utilization cap, a paused source). `maxWithdraw`
  inherits the clamp because OZ derives it as `previewRedeem(maxRedeem(owner))`, so the
  `withdraw` entrypoint's `ERC4626ExceededMaxWithdraw` guard is liquidity-aware too. On a
  fee source `maxWithdraw` still reports the net (fee-adjusted) amount. Deposits do not
  reflect a source entry fee.
- `previewRedeem`/`previewWithdraw` remain **liquidity-agnostic**: EIP-4626 requires
  previews to ignore withdrawal limits, so they value against the full position and never
  consult `maxWithdrawableValue`.
- Dust tradeoff on OZ-style sources (e.g. MetaMorpho, whose own `maxRedeem` floors ~1
  share below `balanceOf` even at full liquidity): a one-call full exit via
  `redeem(balanceOf)` may hit `ERC4626ExceededMaxRedeem`. Callers should exit via
  `redeem(maxRedeem(owner))`; `redeem` is the guaranteed exit and leaves residual dust
  that a follow-up call clears. The dust bound is **one source share's value** — not a
  fixed 1e-12: sub-1e-12 token on fine-grained sources (18-decimal shares, modest price
  per share), but potentially 1e-6 token or more on a coarse-share source (fewer share
  decimals than the asset, or a heavily grown price per share). A redeem whose slice
  values below one source share burns the shares for a **zero payout** (standard
  ERC-4626 dust semantics with the threshold at one source share instead of one wei);
  `previewRedeem` quotes 0 for the same input, and the EIP-5143
  `redeem(shares, receiver, owner, minAssets)` overload reverts `SlippageExceeded` —
  integrators of coarse-share sources should use one of the two.
- The exact-out `withdraw` rounding boundary near `maxWithdraw` remains the one tolerated
  artifact, unchanged by the liquidity-awareness above.

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
