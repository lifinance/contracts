---
name: lifi-pr-review
description: PR-time security review for smart contracts. Triages static-analysis SARIF (Slither / Aderyn / Semgrep) through Pashov's 4-gate FP filter AND reviews the PR diff for new risks, using LI.FI's past audit findings as cached context. Emits curated SARIF + a single human-readable summary.
usage: /lifi-pr-review (typically invoked by .github/workflows/security-review.yml; can be run locally for dry-runs)
---

# LI.FI PR Security Review (Stages 2 + 3)

> **Usage**: invoked automatically by `.github/workflows/security-review.yml`
> on every non-draft PR touching `src/**` or `audit/knowledge/**`. Can be run
> manually from any branch via `/lifi-pr-review` to dry-run the same logic.

## Overview

Two parallel review tracks fused into a single LLM invocation:

| Track | Purpose                                             | Input                                |
| ----- | --------------------------------------------------- | ------------------------------------ |
| A     | Triage Stage 1 SARIF findings (Slither/Aderyn/Semgrep) | `${SARIF_DIR}/*.sarif`             |
| B     | Review the PR diff for risks static tools miss      | `${DIFF_FILE}` (git diff base..head) |

Both tracks consult the same cached LI.FI audit corpus (`audit/knowledge/`)
and apply the same 4-gate FP filter (Pashov / ToB). Findings are merged,
deduped, and emitted as a single curated SARIF + a summary the workflow
posts as one sticky PR comment.

## Inputs

### Per-PR (vary every run)

| Path                       | Source                                  | Notes                                           |
| -------------------------- | --------------------------------------- | ----------------------------------------------- |
| `${SARIF_DIR}/slither.sarif` | Stage 1 slither job                   | May be empty if Slither errored                 |
| `${SARIF_DIR}/aderyn.sarif`  | Stage 1 aderyn job                    | "                                                |
| `${SARIF_DIR}/semgrep.sarif` | Stage 1 semgrep job                   | "                                                |
| `${DIFF_FILE}`             | `git diff origin/main...HEAD`           | The PR's diff against the merge base            |
| `${PR_FILES}`               | Newline-delimited list of changed src/ files | Used to scope `by-area/*.md` loading      |

### Cached (stable across PRs — prompt-cacheable)

| Path                                  | Purpose                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `audit/knowledge/lessons.md`          | Index of every past LI.FI finding (LF-NNN) — always load      |
| `audit/knowledge/by-area/<area>.md`   | Per-area detail for areas matching the diff scope             |
| `audit/findings/waived.yml`           | Explicit FP suppressions (skip findings matching these)       |
| `.agents/rules/`                      | LI.FI conventions (consult when judging "fail-fast" exits etc.) |

### Defaults

If env vars are unset, the skill assumes:

- `SARIF_DIR=/tmp/sarif`
- `DIFF_FILE=/tmp/diff.patch`
- `OUT_DIR=/tmp/output` (where it writes the deliverables)

## Outputs (the skill writes these; the workflow uploads them)

| Path                         | Content                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `${OUT_DIR}/curated.sarif`   | Final SARIF: triaged Stage 1 survivors + Track B new findings, deduped    |
| `${OUT_DIR}/summary.md`      | Human-readable summary for the sticky PR comment                          |
| `${OUT_DIR}/status.json`     | `{verdict: "pass" \| "fail" \| "advisory", critical: N, high: N, ...}` for the status check step |

## Workflow

### Step 0 — Read setup

In a single message, parallel reads:

- `audit/knowledge/lessons.md`
- `audit/findings/waived.yml` (may not exist — graceful fallback to empty)
- `${PR_FILES}` (the list of changed src/ paths)
- `${DIFF_FILE}` (the diff)
- `${SARIF_DIR}/slither.sarif`, `${SARIF_DIR}/aderyn.sarif`, `${SARIF_DIR}/semgrep.sarif`

Then, based on the directories present in `${PR_FILES}`, read the relevant
per-area files:

| Changed path starts with    | Load this                              |
| --------------------------- | -------------------------------------- |
| `src/Facets/`               | `audit/knowledge/by-area/facets.md`    |
| `src/Periphery/`            | `audit/knowledge/by-area/periphery.md` |
| `src/Libraries/`            | `audit/knowledge/by-area/libraries.md` |
| `src/Security/`             | `audit/knowledge/by-area/security.md`  |
| `src/Helpers/`              | `audit/knowledge/by-area/helpers.md` (if exists) |
| Any combination ≥ 2 areas   | also load `cross-cutting.md`           |

### Step 1 — Cost guardrail

If `${PR_FILES}` contains more than 30 src/ files OR the diff exceeds 5000
lines, write a minimal summary explaining "PR too large for AI triage — Stage
1 SARIF still uploaded; please request manual security review" and exit
without consuming further tokens. The Stage 1 findings remain visible in
Code Scanning.

### Step 2 — Track A (triage static findings)

For each finding in the three SARIF files:

1. **Skip if waived**: if `(rule_id, file, line)` matches an entry in
   `audit/findings/waived.yml`, drop the finding.
2. **Skip if skip-listed**: if the finding's rule is in our suppression list
   (see `docs/security-review-baseline.md` § "Tuning recommendation"), drop.
   This catches Slither's noisy `naming-convention`, `too-many-digits`, etc.
3. **Read code context**: ~30 lines around the flagged location.
4. **Match against past findings**: if the recognition-signal of any LF-NNN
   in `lessons.md` matches the flagged pattern, **auto-confirm and link**.
5. **Apply the 4 gates** in order (short-circuit on rejection):
   - **Refutation** — does an existing guard/modifier block the attack? If
     yes → REJECT. Quote the blocking line.
   - **Reachability** — can the vulnerable state exist on a live deployment?
     If structurally impossible → REJECT. If only via privileged setup →
     DEMOTE to informational.
   - **Trigger** — can an unprivileged actor execute this? Trusted-roles-only
     → DEMOTE. Cost > extraction → REJECT.
   - **Impact** — is there material harm to an identifiable victim? Self-harm
     only → REJECT. Dust-only → DEMOTE.
6. **Output for kept findings**: `(rule_id, location, severity_adjusted,
   short_rationale, lf_link)`.

The default disposition for findings the gates don't reject is **kept at the
original tool's severity**. The 4-gate filter is for *removal*, not promotion.

### Step 3 — Track B (review the diff)

Walk the diff hunks. For each:

1. **Identify the changed function(s) / state variables**.
2. **Ask three questions** (the LI.FI Track B rubric):
   - **What invariant changed?** (e.g., "before, fee was capped at 0.1%; now
     uncapped on path X")
   - **What new external surface was created?** (new entry point, new
     external call, new role)
   - **What past finding does this remind me of?** Cross-reference
     `lessons.md` + the loaded `by-area/*.md`. If the recognition-signal
     matches, link the LF-NNN and apply the original finding's severity
     as a starting point.
3. If any answer surfaces a concern, walk that concern through the same 4
   gates as Track A.
4. Output for surviving concerns: `(file, line, severity, attack scenario,
   suggested fix, lf_link?)`.

**Track B explicitly does NOT report**:

- Style, formatting, naming (defer to linters)
- Gas optimizations (defer to dedicated gas reviews)
- "This *could* be refactored" suggestions — only security findings here

### Step 4 — Merge + dedupe

Group findings by `(file, ±5 lines, rule-class)`. If Track A and Track B
both surface a finding at the same site:

- Keep one entry citing both sources.
- Use Track B's severity if it adjusted upward; otherwise Track A's.

### Step 5 — Emit deliverables

Write `${OUT_DIR}/curated.sarif`:

- SARIF 2.1.0 schema
- One run with `tool.driver.name = "lifi-pr-review"`
- One `result` per kept finding with: `ruleId`, `level` (error|warning|note),
  `message`, `locations`, `partialFingerprints.primaryLocationLineHash` so
  Code Scanning can dedupe across pushes
- Each finding's `properties.lf_link` set to the LF-NNN if cross-referenced
- Each finding's `properties.gate_trace` set to the abbreviated 4-gate
  reasoning (≤80 chars)

Write `${OUT_DIR}/summary.md`:

```markdown
## 🛡️ Security Review (EXP-440)

| Severity | Count | Action |
|----------|-------|--------|
| Critical | N     | Must fix |
| High     | N     | Must fix |
| Medium   | N     | Should fix |
| Low      | N     | Could fix |
| Info     | N     | FYI |

### Top findings
- **`LF-046`-like** | High | `src/Facets/AcrossFacetPackedV4.sol:27` —
  bytes32 receiver field for non-EVM destination. (Detected by Track B + Semgrep.)
- … (max 10 entries, sorted severity-desc)

### Tools that contributed
- Slither: X raw → Y kept (Z waived, W skip-listed)
- Aderyn: X raw → Y kept
- Semgrep: X raw → Y kept
- Track B (diff review): N new findings

### Past findings echoed in this PR
- LF-046 (Chainflip bytes32 receiver) — see `audit/knowledge/by-area/facets.md`
- …

_See the **Files changed** tab for inline findings, or the
[Security tab](https://github.com/lifinance/contracts/security) for the
full Code Scanning view._
```

Write `${OUT_DIR}/status.json`:

```json
{
  "verdict": "advisory|pass|fail",
  "critical": 0,
  "high": 0,
  "medium": 0,
  "low": 0,
  "info": 0,
  "ai_cost_estimate_usd": 0.18,
  "ai_input_tokens": 12345,
  "ai_output_tokens": 1234
}
```

For now (advisory mode, EXP-483), always emit `verdict: "advisory"`.
EXP-485 flips the gate by changing this to `"fail"` when
critical+high count > 0.

## Hard rules

- **Never modify files outside `${OUT_DIR}`.** No `src/`, no `audit/`, no
  workflow files. The skill is read-only against the repo.
- **Always emit valid SARIF**, even when there are zero kept findings (empty
  `results: []`). Code Scanning needs a successful upload to mark the
  check green.
- **Never invent past-finding links.** Only cite an LF-NNN if the
  recognition-signal genuinely matches; misleading links are worse than no
  links.
- **One LLM invocation per PR.** Do not spawn sub-agents from this skill.
- **Prompt-cache the corpus.** When loading `lessons.md` + `by-area/*.md`,
  put them ahead of per-PR content in the message so cache hits maximize
  across pushes.

## Skip list (apply before any 4-gate work)

Same as the static-analysis baseline ([docs/security-review-baseline.md](../../docs/security-review-baseline.md)):

| Rule prefix / id pattern                          | Tool    | Action |
| ------------------------------------------------- | ------- | ------ |
| `naming-convention`, `too-many-digits`            | slither | drop   |
| `unused-state`, `unused-return`                   | slither | drop unless directly in changed lines |
| `assembly`, `low-level-calls`, `reentrancy-events`| slither | demote to `note` |
| `todo`, `unused-*`, `*-could-be-immutable`        | aderyn  | drop   |
| `centralization-risk`                             | aderyn  | drop (LI.FI uses admin by design) |
| anything not in our `audit/knowledge/semgrep/`    | semgrep | impossible (Stage 1 only runs our rules) |

## Waiver mechanism

`audit/findings/waived.yml` lets reviewers explicitly suppress findings
the tools repeatedly raise but the team has accepted. Schema:

```yaml
- id: SLITHER-MISSING-ZERO-CHECK-ACROSSFACET-L47
  rule: missing-zero-check
  tool: slither
  file: src/Facets/AcrossFacet.sol
  line: 47
  rationale: |
    _wrappedNative is set in the constructor and validated in the
    integration tests; a zero-address here would break deployment
    immediately, not after deploy.
  signed_off_by: '@security-team-lead'
  expires: 2027-01-01
```

`expires` is mandatory — waivers go stale; quarterly review (per EXP-485
runbook) re-verifies them.

## Cost budget

| PR shape                       | Target cost      |
| ------------------------------ | ---------------- |
| Small (≤5 changed files)       | $0.05–0.15       |
| Medium (6–15 files)            | $0.15–0.40       |
| Large (16–30 files)            | $0.40–0.80       |
| Huge (>30 files)               | Skipped (Step 1) |

Sonnet 4.6 used by default; Haiku fallback available via `claude_args` if
budget exceeded.

## Reference

- `.agents/commands/extract-audit-knowledge.md` — sibling skill that
  generates the corpus this one consumes
- `docs/security-review-baseline.md` — EXP-482 noise baseline informing
  the skip list
- `audit/knowledge/lessons.md` — input
- ToB upstream patterns:
  `plugins/fp-check/skills/fp-check/SKILL.md` (4-gate rubric source)
  `plugins/differential-review/skills/differential-review/methodology.md` (Track B inspiration)
