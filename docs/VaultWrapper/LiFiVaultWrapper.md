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

## Exit semantics

`redeem` (exact-in, share-sourced) and `withdraw` (exact-out, asset-sourced)
tolerate a misbehaving yield source differently:

- **`redeem`** is loss-tolerant: it burns the shares, realizes their valuation
  from the source via the adapter's `withdrawUpTo`, and pays out whatever the
  source actually delivered. The withdrawal fee is charged on the ACTUAL
  proceeds (not the nominal target), so a shortfall shrinks fee and payout
  together rather than reverting the whole exit. Actual proceeds are both the
  return value and the `Withdraw` event amount. `previewRedeem` mirrors the
  same realizable math, so an honest source still previews exactly what
  `redeem` pays, and the EIP-5143 `redeem` overload bounds the caller's
  exposure to a lying one. When the burn empties `totalSupply`, both `redeem`
  and `previewRedeem` switch to a full-drain sweep of the whole position
  instead of the floor-rounded value of the finite target — leaving no
  valueful residue behind an empty vault, which would otherwise recreate the
  supply-zero/assets-positive inflation-attack precondition. A last-share exit
  whose whole-position value itself floors below 1 wei can still leave
  sub-wei residue; it is bounded, accrues to the next depositor, and stays
  behind the same inflation guards.
- **`withdraw`** stays strict: it targets an exact asset amount and reverts
  `AdapterWithdrawShortfall` if the source pays less. `previewWithdraw` is
  cost-aware — it prices the share burn off the position value the source
  will actually consume to deliver the exact amount (`previewWithdrawCost`,
  which grosses up for a source-side exit fee), so the exiting caller pays
  their own exit cost via a larger share burn instead of diluting the
  remaining holders.

`maxWithdraw`/`maxRedeem` are liquidity- and realizability-aware: each
candidate is FORWARD-VERIFIED through the exact preview its entrypoint
executes (`previewWithdraw`/`previewRedeem`), so the reported ceiling never
lets a caller's next call revert on that basis — it may under-report by a wei
rather than over-report. Both are fail-soft: a broken source-side limit view
reads as closed (0), including `maxRedeem` returning 0 when the source's
liquidity view itself reads 0 — a deliberate fail-closed posture even for a
dust-sized position. `maxDeposit`/`maxMint` are fail-soft the same way (0 on a
reverting or malformed source cap) and fee-gross a positive cap while
preserving the unlimited sentinel. Per EIP-4626, none of the four preview
functions (`previewDeposit`/`previewMint`/`previewWithdraw`/`previewRedeem`)
cap at these limits — only the `max*` views do.

A reverting source-side `maxDeposit` view degrades to 0 the same as any other
fail-soft limit, which means `deposit`/`mint` revert `ERC4626ExceededMaxDeposit`/
`ERC4626ExceededMaxMint` even if the source's own `deposit` function would have
worked — the fail-soft-to-0 coupling is deliberate: a source whose limit view
cannot be trusted is treated as closed rather than risking silent over-deposit.

`totalAssets()` stays valuation-based (the adapter's `convertToAssets` on the
wrapper's position) rather than realizable — a deliberate asymmetry: exits
realize what the source can actually deliver and the exiting caller bears any
exit cost, while share price (and the management/performance fees and
high-water mark derived from it) stays an upper bound on what a share is
worth, not a promise of what redeeming it nets on a fee-charging source.

**Residual risks.** A source whose preview functions revert blocks `redeem`
and the exit-limit views that route through those previews; recovery is a
beacon upgrade (subsystem governance, 48h timelock). A well-formed source that
lies in its own favor (over-quoting a preview) can only be bounded by the
caller's own EIP-5143 overload, not detected by the wrapper. Deposit-side
share dilution (a source that consumes the full deposited asset but credits
fewer shares than a standard vault would) is not caught by either exit
primitive and remains unsupported — it needs a dedicated adapter.

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
