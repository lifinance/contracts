# Demo fixture — a bug only `differential-review` catches

> **This branch (`demo/diff-review-positive-slippage`) is a demonstration fixture.
> It intentionally introduces a vulnerability and must never be merged.**

## Purpose

Show that the LI.FI security-review pipeline catches a class of bug that the
static scanners in Stage 1 (Slither, Semgrep) structurally cannot — proving the
ToB `differential-review` skill is the part doing the real bug-finding, not the
scanners.

## The planted bug

In `AcrossFacetV4.sol`, `swapAndStartBridgeTokensViaAcrossV4` runs a swap before
bridging. The swap changes the input amount (`_bridgeData.minAmount`), so the
destination-side `outputAmount` — the amount the recipient is promised on the
destination chain — must be rescaled proportionally. The production code does
this (the `outputAmountMultiplier` block, lines 137-147 in the clean file; cited
as the reference implementation in `.agents/rules/102-facets.md`).

The fixture removes that rescaling, passing the caller-supplied `_acrossData`
straight through:

```solidity
_bridgeData.minAmount = _depositAndSwap(
    _bridgeData.transactionId,
    _bridgeData.minAmount,
    _swapData,
    payable(msg.sender)
);

_startBridge(_bridgeData, _acrossData); // outputAmount no longer rescaled
```

It looks like a harmless simplification. It is a value-flow bug: after a swap the
bridged `inputAmount` and the promised `outputAmount` diverge, so positive
slippage from the swap is silently skimmed instead of reaching the user, and a
relayer can fill the deposit for less than the input is worth.

## Why the static scanners miss it

The bug is the **absence** of a business-logic line. There is no dangerous
pattern to match:

- no reentrancy, no unchecked external call, no arbitrary send
- `_depositAndSwap`'s return value is still assigned (no unused-return)
- it compiles cleanly

Slither matches dangerous code shapes; Semgrep matches code that *exists*.
Neither can flag a missing rescale.

### Reproduce the scanner silence (deterministic)

Both scanners produce identical output on the clean and buggy file — same
versions Stage 1 pins (Slither 0.11.3, Semgrep 1.117.0):

```bash
slither src/Facets/AcrossFacetV4.sol \
  --sarif slither.sarif --exclude-informational --exclude-low --fail-none
semgrep scan --config=audit/knowledge/semgrep src/Facets/AcrossFacetV4.sol \
  --sarif --output=semgrep.sarif --metrics=off
```

| Scanner | clean | buggy | new findings |
| ------- | ----- | ----- | ------------ |
| Slither | 2 (both in `LibAsset` / `SwapperV2`) | 2 (identical) | **0** |
| Semgrep | 0 | 0 | **0** |

## What `differential-review` is expected to produce

A Medium/High finding along these lines:

> **Post-swap `outputAmount` not rescaled — positive slippage leaks.**
> `swapAndStartBridgeTokensViaAcrossV4` updates `minAmount` from the swap output
> but bridges with the caller-supplied `outputAmount`, which was sized for the
> pre-swap amount. Input and output amounts diverge; slippage gain does not reach
> the recipient. Echoes the `outputAmountMultiplier` requirement in rule 102 and
> the post-swap-amount-adjustment finding class in the audit corpus.

This comes from `differential-review`'s value-flow / blast-radius analysis (input
amount vs. output amount across the swap), reinforced by the LF corpus loaded in
the skill's Pre-Analysis step — none of which a pattern scanner performs.

## Running the live pipeline against this fixture

Open a PR from this branch against the branch carrying the pipeline
(`feature/exp-440-security-review-pipeline`, or `main` once it merges). The
`security-review` workflow runs: Stage 1 SARIF stays clean on this facet, and the
Stage 2 sticky comment should carry the finding above.
