# Security Review — Stage 1 Noise Baseline

> EXP-482. Measures the false-positive rate of the EXP-480 static-analysis
> pipeline (Slither + Aderyn + Semgrep) on the LI.FI contracts codebase, so
> EXP-484 can tune the AI triage layer to the right signal level.

## Methodology

This baseline is **snapshot-based**, not per-PR-replay-based, for two reasons:

1. The Stage 1 workflow runs the three tools on the **full** `src/` tree, not on
   PR diffs (matching `olympixStaticAnalysis.yml`'s pattern). Code Scanning then
   dedupes via fingerprint, so the "noise per PR" experienced by reviewers is
   the count of findings in files the PR touched, not the entire repo's
   findings.
2. A snapshot of `src/` produces stable, reproducible counts. Per-PR
   measurements require running tools against historical merge commits, which
   adds compile complexity for marginal additional signal. The per-PR section
   below approximates this by counting snapshot findings against changed files
   in sampled PRs.

### Versions

| Tool    | Version  | Source                                                     |
| ------- | -------- | ---------------------------------------------------------- |
| Slither | 0.11.3   | `slither --sarif … src/`                                   |
| Aderyn  | 0.6.8    | `aderyn --output …sarif .` (Foundry auto-detect)           |
| Semgrep | 1.117.0  | `semgrep --config=audit/knowledge/semgrep --sarif src/`    |

Scan commit: `7f5259af` (tip of `feature/exp-480-static-analysis-ci`, ahead of
`origin/main` by the EXP-478/479/480 commits but with `src/` unchanged vs the
base; for severity classes that depend on file content, results are
representative of `main` at branch-time).

### Classification rubric

Each finding is sorted into one of three buckets:

- **Skip-list FP** — matches an LI.FI documented skip-list pattern
  (`.agents/commands/extract-audit-knowledge.md` Step 3): gas, naming, NatSpec,
  formatting, code-quality without security path.
- **Informational** — real observation, no exploitable security path. Useful
  as a hint but not actionable.
- **Likely TP** — describes a possible exploit path; warrants human review.

Numbers below are **heuristic**, derived from rule semantics + observed
samples, not from per-finding human triage. EXP-484 produces the rigorous
classification.

---

## Headline numbers

| Tool    | Total findings | Skip-list FP | Informational | Likely TP | TP rate |
| ------- | -------------- | ------------ | ------------- | --------- | ------- |
| Slither | 1,037          | 674 (65%)    | 114 (11%)     | ~187 (18%) | ~5–10%¹ |
| Aderyn  | 33             | 16 (48%)     | 4 (12%)       | 13 (40%)  | ~40%    |
| Semgrep | 241            | 0²           | ~40 (17%)     | ~50 (20%) | ~15–20% |
| **Total** | **1,311**    | **~690 (53%)** | **~158 (12%)** | **~250 (19%)** | **~10–15%** |

¹ Slither's "Likely TP" bucket includes a Mixed sub-bucket where ~50% of
findings are real after closer inspection. Net TP rate after manual review is
lower than the 18% upper bound. <br>
² Semgrep runs only our own LI.FI rules. By construction none match the
skip-list patterns. Noise comes from rule over-broadness, not topic relevance.

**Bottom line**: out of 1,311 raw findings on the current codebase, an
estimated 130–200 are worth a human's attention. The other ~1,100 are noise
the AI triage layer (EXP-483) and rule-config tuning (EXP-484) must suppress
before enforcement (EXP-485) is safe.

---

## Slither — 1,037 findings

Slither produces the largest volume. Most is style and code-quality.

| Rule                       | Count | Bucket          | Reason                                              |
| -------------------------- | ----: | --------------- | --------------------------------------------------- |
| naming-convention          |   454 | Skip-list FP    | Pure style                                          |
| unused-state               |   129 | Skip-list FP    | Most are intentional constants in `LiFiData.sol`    |
| calls-loop                 |   102 | Mixed           | Real DoS in some places, intentional in others      |
| too-many-digits            |    91 | Skip-list FP    | Pure style                                          |
| reentrancy-events          |    60 | Informational   | Slither's "events emitted after external call"      |
| msg-value-loop             |    38 | Likely TP       | Matches our LF-053 pattern; real concern            |
| assembly                   |    34 | Informational   | Required for diamond storage                        |
| unused-return              |    24 | Mixed           | Some real (ignored failure), most intentional       |
| missing-zero-check         |    23 | Mixed           | Many constructors; some validated elsewhere         |
| low-level-calls            |    20 | Informational   | Required for some bridge interactions               |
| _other_ (62 distinct rules)|   162 | Mostly skip-list FP | One-off rules with low individual signal       |

### Top FP categories (Slither)

1. **Naming convention** — 454 findings on parameter prefix conventions. Every
   LI.FI parameter uses `_paramName`; Slither expects `paramName`. Suppress
   wholesale via `slither.config.json`'s `detectors_to_exclude`.
2. **Unused state constants** — 129 in `LiFiData.sol` (chain IDs etc.). The
   detector doesn't model `using` imports across facets. Suppress on a
   per-file basis or via the same config.
3. **Too many digits** — 91 on bit masks and address constants. Style only.
4. **Reentrancy with event emission** — 60. Real reentrancy is caught by
   separate detectors; these are informational. Suppress.

### Tuning recommendation (EXP-484)

Add `slither.config.json` at the repo root with:

```jsonc
{
  "detectors_to_exclude":
    "naming-convention,too-many-digits,unused-state,reentrancy-events,assembly,low-level-calls"
}
```

Expected reduction: 1037 → ~250 findings (~75% noise removed in one config change).

---

## Aderyn — 33 findings

High signal-to-noise. Each finding is a unique rule that fires on one location
in the codebase.

### Likely TP (13)

- `abi-encode-packed-hash-collision` (Permit2Proxy)
- `contract-locks-ether` (AcrossFacetPacked)
- `eth-send-unchecked-address` (GenericSwapFacetV3)
- `msg-value-in-loop` (SwapperV2) — matches LF-053
- `reentrancy-state-change` (HopFacetPacked)
- `unsafe-casting` (AcrossFacetPacked)
- `costly-loop` (DeBridgeDlnFacet)
- `delegatecall-in-loop` (EmergencyPauseFacet)
- `state-change-without-event` (OwnershipFacet) — matches LF-008
- `state-no-address-check` (TransferrableOwnership)
- `unchecked-return` (CelerCircleBridgeFacet)
- `unsafe-erc20-operation` (CelerCircleBridgeFacet) — matches LF-002
- `require-revert-in-loop` (AcrossFacetPacked)

### Informational (4)

- `yul-return` (LiFiDiamond) — diamond pattern requires it
- `push-zero-opcode` (GenericErrors) — version-target hint
- `solmate-safe-transfer-lib` (AcrossFacetPacked) — known choice
- `missing-inheritance` (EmergencyPauseFacet) — false signal on diamond facet

### Skip-list FP (16)

`todo`, `unused-error`, `unused-import`, `unused-public-function`,
`unused-state-variable`, `large-numeric-literal`, `literal-instead-of-constant`,
`modifier-used-only-once`, `internal-function-used-once`,
`state-variable-could-be-immutable`, `unspecific-solidity-pragma`,
`deprecated-oz-function`, `reused-contract-name`, `local-variable-shadowing`,
`uninitialized-local-variable`, `centralization-risk`.

`centralization-risk` is borderline — LI.FI has admin functions by design, so
the flag is technically real but always acceptable. Treat as known-good.

### Tuning recommendation (EXP-484)

Generate an `aderyn.toml` to exclude the 16 skip-list-FP rules. Expected
reduction: 33 → 17 findings, of which ~13 are real.

---

## Semgrep — 241 findings (LI.FI custom rules)

These are our own rules; noise comes from over-broad patterns.

| Rule                                       | Count | Estimated FP rate | Note                                                       |
| ------------------------------------------ | ----: | ----------------: | ---------------------------------------------------------- |
| lf-046-bytes32-nonevm-receiver             |   111 |             80–90% | Regex matches any `bytes32 receiver`; LF-046 was specific |
| lf-029-shared-modifier-parallel-fields     |    96 |               80% | Matches any `.receiver` read without companion guard       |
| lf-053-loop-msg-value                      |    14 |             40–50% | Targeted but still matches intentional uses                |
| lf-008-admin-fn-without-event              |    13 |             30–50% | Many onlyOwner functions do emit events                    |
| lf-002-direct-ierc20-approve               |     7 |               10% | Targeted; mostly real anti-pattern                         |

### Tuning recommendation (EXP-484)

Three of the rules (lf-046, lf-029, lf-008) have inline TODO comments in their
YAML noting the over-broadness. Tighten by adding `pattern-not-inside` /
`pattern-inside` constraints to scope to functions where the pattern is
actually exploitable, e.g.:

- lf-046 — require the field to be passed across an external chain boundary
  (in a non-EVM bridge context), not just declared.
- lf-029 — require absence of a `bridgeData.receiver == specificData.receiver`
  guard in the same function.
- lf-008 — require absence of *any* `emit` in the function (current rule is
  generic-language which can't easily express this).

Expected reduction: 241 → ~50 findings, of which ~30 are real.

---

## Per-PR estimate (3 sampled merged PRs)

Counts of snapshot findings in the `src/` files modified by each PR. This is
an **upper bound** — Code Scanning will dedupe pre-existing findings on the
unchanged portions of those files, so the reviewer-visible "new" count is
lower.

| PR     | src/ files | Slither | Aderyn | Semgrep | Total |
| ------ | ---------: | ------: | -----: | ------: | ----: |
| #1715 (GenericSwap migration) | 6 | 92 | 30 | 1 | **123** |
| #1551 (WhitelistManager)      | 4 | 45 | 19 | 0 | **64**  |
| #1550 (AcrossV4SwapFacet new) | 6 | 25 | 63 | 27 | **115** |
| **Average**                   |   | 54 | 37 | 9  | **~100** |

**Interpretation**: with no config tuning, a typical PR's reviewer will see
~100 raw findings flagged on Code Scanning. After EXP-484 tuning (skip-list
suppression at the tool config level + Semgrep rule tightening), this drops
to an estimated **15–25 raw findings per PR**, of which **3–8 are real**.
The Stage 2 AI triage (EXP-483) then filters the survivors through Pashov's
4-gate rubric, targeting **1–3 actionable findings per PR** at steady state.

---

## What this baseline does NOT measure

- **Per-PR delta** — the live CI delta between two consecutive runs of the
  same workflow on the same branch. Only verifiable by deploying EXP-480 and
  running it against real PRs.
- **Code Scanning fingerprint dedup** — GitHub's dedup behavior on file
  changes vs same-file findings. Will affect the visible PR count downward.
- **AI triage precision/recall** — the contribution of the EXP-483 layer.
  That's EXP-484's job to measure.

These three lacunae make this baseline a **starting point** for tuning, not
the final word on signal-to-noise.

---

## Concrete next actions

1. **EXP-484** — open follow-up work to author the three config files
   (`slither.config.json`, `aderyn.toml`, refined Semgrep rules under
   `audit/knowledge/semgrep/`). Expected effort: ~half a day for the configs,
   another half-day to validate the noise reduction on the same snapshot.
2. **EXP-480** test PR — once the workflow ships to a PR, capture the actual
   Code Scanning counts on the first 5 PRs and reconcile with this baseline.
3. **Carry forward into EXP-483** — the AI triage skill should be tuned with
   the post-config-tuning noise floor (~15–25 raw findings/PR), not the raw
   (~100/PR). Avoids over-engineering the AI for noise that's already
   suppressible deterministically.
