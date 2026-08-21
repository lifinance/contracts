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
  offset derived at `initialize` (floored at a nonzero minimum of 6), plus a
  `ZeroSharesMinted` revert on any deposit that would round to zero shares. There
  is deliberately no enforced minimum share supply — see
  [Donation griefing](#donation-griefing--accepted-bounds).
- A single pluggable `IAccessGate` (zero = permissionless) enforced fail-closed on
  entry, share transfers, and exits.
- Pause is enforced on the deposit/mint path only; withdrawals stay open.
- The entry `max*` views are source-cap-aware — see
  [Entry semantics](#entry-semantics).
- The exit `max*` views are source-liquidity-aware — see
  [Exit semantics](#exit-semantics).

## Entry semantics

- `maxDeposit`/`maxMint` clamp to what the source will currently accept (via the
  adapter's `maxDepositableValue`), so a `deposit`/`mint` within the reported max
  never reverts under a source inflow cap (an ERC-4626 supply cap, e.g.
  MetaMorpho). An uncapped source reports `type(uint256).max`, passed through
  unchanged (`maxMint` skips the share conversion to avoid overflow) so the views
  stay unbounded exactly when the source is. This is the entry-side mirror of the
  exit-liquidity clamp below.
- Both views report `0` while any pause source is engaged or the access gate
  rejects the receiver, so EIP-4626 consumers see the vault as closed rather than
  building a deposit that would revert `DepositsPaused`.
- Because they consult the source's `maxDeposit`, they revert if that view
  reverts (a bricked source) — fail-closed by design, the same deliberate
  deviation from EIP-4626's never-revert expectation noted for the exit views.
- `previewDeposit`/`previewMint` remain **cap-agnostic**: EIP-4626 requires
  previews to ignore deposit limits, so they value the requested amount and never
  consult `maxDepositableValue`.

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

## Donation griefing — accepted bounds

There is deliberately no enforced minimum share supply. The virtual-share
offset (minimum 6) is the sole inflation/donation defense; the following are
accepted by design, every bound deriving from the offset alone:

- A depositor's rounding loss against a donation-inflated price is bounded by
  ~`donation / 10^offset` — at the minimum offset, one-millionth of what the
  attacker burns. A deposit that would round to zero shares reverts
  `ZeroSharesMinted`; assets are never taken for no shares. Zeroing a given
  deposit costs ~1e6× that deposit and the donation accrues to the vault, so
  the grief is self-defeating.
- Deposits and mints can transact at any dust supply. A position held there
  is either dust (at most ~1e-12 of a share token at par price) or subsidized
  by a donation of which more than half is forfeited to the virtual-share
  offset on exit — engineering the state is always loss-making.
- Performance-fee forgiveness is per accrual, sub-step rounding only: each
  accrual forgives at most ~one share's worth of fee (the dilution rounds to
  zero below that) — i.e. gain up to ~one share's value / feeRate — plus
  sub-wei flooring of the gain measurement. Bounded, holder-favouring, never
  a depositor loss.

## Access gate — trust model

The pluggable `IAccessGate` is the one per-vault privilege with **no factory
allowlist** behind it: unlike `adapter` and `underlying`, the owner installs
arbitrary gate code through `setAccessGate` with no vetting. This is deliberate.
The gate runs fail-closed on entry, transfers, and exits, so a faulty or hostile
gate can freeze the integrator's own depositors while the fee engine keeps
accruing on the frozen AUM — but that blast radius is confined to the
integrator's own product, and `setAccessGate` reverses it instantly. The
per-vault owner (the integrator) is therefore trusted not to brick its own
exits. There is no instance-level counter-lever; the only subsystem-wide remedy
is a beacon upgrade behind the 48h timelock.

The same trust covers LI.FI's own cut. A gate the integrator controls can flag
the live `lifiFeeRecipient` as sanctioned, so once `distributeFees` mints LI.FI's
share-side fees (management, performance) to that address they can be neither
redeemed nor transferred out — confiscating the accrued balance even though the
recipient is read live from the factory. The integrator is trusted not to
sanction the LI.FI recipient in its own gate. This reaches only the share-side
fees; deposit and withdrawal fees settle in the asset token, which the gate does
not touch.

## Admin role

The per-vault admin is OZ's two-step `owner`
(`transferOwnership` / `acceptOwnership`). `renounceOwnership` is disabled — a
custody contract must never be left ownerless.

## Fee rate changes — trust model

`setFeeRate` accrues at the OLD rate first, so management and performance fees
are never charged retroactively across a change. The asset-side deposit and
withdrawal rates have no such carry-over: a new rate binds the next transaction
in the same block. The owner can therefore raise the withdrawal rate to the
factory bound for exactly the block that carries a victim's already-signed
`redeem`/`withdraw` and lower it afterwards — a one-block fee sandwich against
plain ERC-4626 callers.

This is accepted design. The per-vault owner (the integrator) is trusted not to
act against its own depositors — the same trust the access gate already requires.
Three things bound it:

- The rate can never exceed the factory's live `feeBounds` for the type, which
  LI.FI governance sets within the immutable bytecode cap (20% for both deposit
  and withdrawal). Setting the bound to the smallest workable value shrinks the
  worst case.
- The EIP-5143 slippage overloads bound the assets a caller actually pays, so a
  caller that passes a floor is protected regardless of an in-flight rate change.
- The owner authority model is pluggable: an integrator that wants to give up the
  instant-change lever can own its instance through a timelock, making every rate
  change delayed and publicly visible before it can bind.

## Initialization

`initialize` is called once by the factory immediately after the proxy is
deployed. It sets the identity (`underlying` / `adapter` / `owner` / `factory`),
the initial fee configuration, receivers, and access gate; resolves the ERC-20
asset via the adapter; derives the virtual-share offset from the asset decimals;
and sets a provisional performance watermark at the empty-vault share price. That
par value is only a placeholder: every accrual ratchets the watermark up to the
live price (charging the gain when the fee dilution mints shares, forgiving it
when it rounds to zero), so assets donated to the instance's predicted address —
empty or dust vault alike — become the next depositor's baseline instead of
being charged to them as fabricated gain.

## Upgradeability and the FACTORY binding

Instances are `BeaconProxy` contracts; the `UpgradeableBeacon` is owned by the
subsystem's 48h timelock, so a `upgradeTo` repoints every live instance to a new
implementation at once. `FACTORY` is an **implementation immutable** (bytecode, not
proxy storage), and it is the source every instance reads for the factory-level
global circuit breaker (`globalPaused`), fee bounds, and `lifiFeeRecipient`, as well
as the `initialize` caller check.

`FACTORY` points at the factory's `TransparentUpgradeableProxy`, not its logic
contract, so the factory's own logic can be upgraded (through the proxy's
timelock-owned `ProxyAdmin`) without changing the address instances read from — see
[LiFiVaultWrapperFactory.md](./LiFiVaultWrapperFactory.md#upgradeability).

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
