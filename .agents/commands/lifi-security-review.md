---
name: lifi-security-review
description: PR-time security review for smart contracts. Thin LI.FI orchestrator over Trail of Bits' open-source Claude Code skills (audit-context-building, differential-review, fp-check). Injects LI.FI's past-audit corpus and waivers (when present); emits curated SARIF + sticky-comment summary in the format the security-review workflow expects.
usage: /lifi-security-review (typically invoked by .github/workflows/security-review.yml; can be run locally for dry-runs)
---

# LI.FI PR Security Review (Stages 2 + 3)

> **Usage**: invoked automatically by `.github/workflows/security-review.yml`
> on every non-draft PR touching `src/**`. Can be run manually from any branch
> via `/lifi-security-review` to dry-run the same logic — first initialize the
> vendored ToB skills the `.claude/plugins/*` symlinks point at:
> `git submodule update --init .claude/vendor/tob-skills`.

## Design

This skill is a **thin LI.FI integration layer** over vendored Trail of Bits
Claude Code skills (see `NOTICE` at repo root for license + attribution).
The reasoning machinery — gate reviews, blast-radius calculation, attacker
modeling, etc. — lives in the ToB plugins. Our job is:

1. **Provide LI.FI-specific inputs**: the LF-NNN audit corpus, our Semgrep
   rule set, and the explicit waiver file (when present).
2. **Orchestrate the ToB skills** with those inputs.
3. **Re-emit their outputs in the schema our workflow expects**:
   `curated.sarif` (for Code Scanning), `summary.md` (for the sticky comment),
   `status.json` (for the status check that a later change flips to gating).

If the ToB skills change their methodology, this skill picks up the change
automatically the next time we bump `.claude/vendor/tob-skills`. We do not
fork or modify their files — the wrapper stays MIT/LGPL, theirs stays
CC-BY-SA-4.0 (see NOTICE).

## ToB skills used

| Skill                                                          | Role in our pipeline                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| `.claude/plugins/audit-context-building/`                      | Pre-Analysis: load LF-NNN corpus as baseline context          |
| `.claude/plugins/differential-review/`                         | Risk-first 7-phase review of the PR diff                      |
| `.claude/plugins/fp-check/`                                    | Per-finding TP/FP verification (6 gates)                      |
| `.claude/plugins/semgrep-rule-creator/`                        | Out of scope for per-PR runs (rule authoring only)            |

## Inputs

### Per-PR (vary every run)

| Path                       | Source                                  | Notes                                           |
| -------------------------- | --------------------------------------- | ----------------------------------------------- |
| `${SARIF_DIR}/slither.sarif` | Stage 1 slither job (`--exclude-informational --exclude-low`) | May be empty if Slither errored |
| `${SARIF_DIR}/semgrep.sarif` | Stage 1 semgrep job (LI.FI custom rules from `audit/knowledge/semgrep/`) | May be empty if Semgrep errored |
| `${DIFF_FILE}`             | `git diff <base>...<head> -- src/`      | PR diff against merge base, scoped to `src/`    |
| `${PR_FILES}`               | Newline-delimited list of changed src/ files | Used to scope `by-area/*.md` loading      |

### LI.FI-specific cached inputs (stable across PRs — prompt-cacheable)

| Path                                  | Purpose                                                       |
| ------------------------------------- | ------------------------------------------------------------- |
| `audit/knowledge/lessons.md`          | Index of every past LI.FI finding (LF-NNN) — always load      |
| `audit/knowledge/by-area/<area>.md`   | Per-area detail for areas matching the diff scope             |
| `audit/findings/waived.yml` (optional) | FP waivers, applied only if the file exists (schema in `docs/security-review.md`) |
| `.agents/rules/`                      | LI.FI conventions (consult when judging "fail-fast" exits etc.) |

### Defaults

If env vars are unset, the skill assumes:

- `SARIF_DIR=/tmp/sarif`
- `DIFF_FILE=/tmp/diff.patch`
- `OUT_DIR=/tmp/output`

## Outputs (the skill writes these; the workflow uploads them)

| Path                         | Content                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| `${OUT_DIR}/curated.sarif`   | Final SARIF: triaged Stage 1 survivors + diff-review findings, deduped    |
| `${OUT_DIR}/summary.md`      | Human-readable summary for the sticky PR comment                          |
| `${OUT_DIR}/status.json`     | `{verdict, critical, high, medium, low, info}` for the status check step  |

## Workflow

### Step 0 — Load LI.FI context

Read in a single parallel batch:

- `audit/knowledge/lessons.md`
- `audit/findings/waived.yml` (optional — graceful fallback to empty if missing)
- `${PR_FILES}`
- `${DIFF_FILE}`
- `${SARIF_DIR}/*.sarif`

Based on directories in `${PR_FILES}`, load the relevant `by-area/*.md`:

| Changed path starts with    | Load this                              |
| --------------------------- | -------------------------------------- |
| `src/Facets/`               | `audit/knowledge/by-area/facets.md`    |
| `src/Periphery/`            | `audit/knowledge/by-area/periphery.md` |
| `src/Libraries/`            | `audit/knowledge/by-area/libraries.md` |
| `src/Interfaces/`           | `audit/knowledge/by-area/cross-cutting.md` |
| `src/Security/`             | `audit/knowledge/by-area/security.md`  |
| `src/Helpers/`              | `audit/knowledge/by-area/cross-cutting.md` |
| Any combination ≥ 2 areas   | also load `cross-cutting.md`           |

### Step 1 — Cost guardrail

If `${PR_FILES}` has more than 30 src/ files OR `${DIFF_FILE}` exceeds
5000 lines, write a minimal summary explaining "PR too large for AI
triage — Stage 1 SARIF still uploaded; please request manual security
review" and exit. Stage 1 findings remain visible in Code Scanning.

### Step 2 — Pre-Analysis (invoke `audit-context-building`)

Invoke the `audit-context-building` skill with the LI.FI corpus loaded
in Step 0 as the baseline context. This builds the bottom-up structural
understanding `differential-review` expects in its Pre-Analysis phase.

LI.FI-specific addition: when `audit-context-building` enumerates
invariants, also surface any LF-NNN finding whose `recognition_signal`
matches a structure in the changed code. These cross-references become
**inputs** to the next two steps (not outputs yet).

### Step 3 — Diff review (invoke `differential-review`)

Hand off `${DIFF_FILE}` + the LF-NNN cross-references from Step 2 to
the `differential-review` skill. Let it run its full 7-phase workflow
(Pre-Analysis → Triage → Code Analysis → Test Coverage → Blast Radius
→ Deep Context → Adversarial → Report). When it produces findings,
each finding becomes a **suspected bug** for Step 4.

### Step 4 — Per-finding verification (invoke `fp-check`)

Build the verification queue from **two sources**:

1. **Stage 1 SARIF survivors**: Slither (and Semgrep) run **repo-wide**, so the
   SARIF carries findings from across `src/`, not just this PR. Filter, in order:
   1. **Scope to the PR (mandatory)** — keep only findings whose location file
      is listed in `${PR_FILES}` (the changed `src/` files). Drop every finding
      in a file this PR did not touch: it is pre-existing, not introduced here,
      and out of scope for a per-PR review. Without this step a repo-wide
      Slither run (100+ raw findings) floods `fp-check` with unchanged code and
      surfaces alerts the PR is not responsible for.
   2. **Drop waivers** — remove anything matching `audit/findings/waived.yml`
      (only if that file exists — see its schema in `docs/security-review.md`).

   The survivors are treated as "suspected bugs" needing TP/FP verification.
2. **`differential-review` findings**: each finding it surfaced in Step 3.

For each suspected bug, invoke the `fp-check` skill in batch-triage mode.
`fp-check` will route Standard vs Deep per its own rules, run its 6-gate
review, and return a TRUE POSITIVE / FALSE POSITIVE verdict with evidence.

**Severity floor for LF-NNN matches**: if a finding's recognition signal
matches a confirmed past LI.FI finding, start `fp-check` with that
finding's original severity as the prior; `fp-check` may still demote
it to FP, but the LI.FI history is on the table.

### Step 5 — Emit deliverables

The ToB skills emit their own markdown reports in their own formats; we
**do not surface those directly** to the PR comment. Instead, we
normalize all verified TPs from Step 4 into our existing schema:

**`${OUT_DIR}/curated.sarif`**:

- SARIF 2.1.0 schema
- One run with `tool.driver.name = "lifi-security-review"`
- One `result` per kept finding with `ruleId`, `level`, `message`,
  `locations`, `partialFingerprints.primaryLocationLineHash` (dedup
  across pushes)
- `properties.lf_link` set to the LF-NNN if cross-referenced
- `properties.gate_trace` set to the abbreviated fp-check gate-review
  rationale (≤80 chars)
- `properties.upstream_skill` set to `"fp-check"` /
  `"differential-review"` so downstream tooling can attribute the
  finding source

**`${OUT_DIR}/summary.md`**:

```markdown
## 🛡️ Security Review

| Severity | Count | Action |
|----------|-------|--------|
| Critical | N     | Must fix |
| High     | N     | Must fix |
| Medium   | N     | Should fix |
| Low      | N     | Could fix |
| Info     | N     | FYI |

### Top findings
- **`LF-046`-like** | High | `src/Facets/AcrossFacetPackedV4.sol:27` —
  bytes32 receiver field for non-EVM destination. (fp-check verdict: TP.)
- … (max 10 entries, sorted severity-desc)

### Tools that contributed
- Slither:           X raw (repo-wide) → Y in changed files → Z confirmed by fp-check
- Semgrep:           X raw (repo-wide) → Y in changed files → Z confirmed by fp-check
- differential-review: N new findings (M confirmed by fp-check)

### Past findings echoed in this PR
- LF-046 (Chainflip bytes32 receiver) — see `audit/knowledge/by-area/facets.md`
- …

_See the **Files changed** tab for inline findings, or the
[Security tab](https://github.com/lifinance/contracts/security) for the
full Code Scanning view._
```

**`${OUT_DIR}/status.json`**:

```json
{
  "verdict": "advisory|pass|fail",
  "critical": 0,
  "high": 0,
  "medium": 0,
  "low": 0,
  "info": 0,
  "tob_skill_versions": {
    "fp-check": "1.0.0",
    "differential-review": "1.0.0",
    "audit-context-building": "1.0.0"
  }
}
```

For now (advisory mode), always emit `verdict: "advisory"`. Gating is
enabled later by changing this to `"fail"` when critical+high > 0.

## Hard rules

- **Never modify files outside `${OUT_DIR}`.** Read-only against the repo.
- **Never modify files inside `.claude/vendor/tob-skills/`.** Modifying a
  CC-BY-SA-4.0 file forces our changes under the same license. Wrap, don't
  fork. If we need behavior the ToB skill doesn't support, encode it in
  *this* file.
- **Always emit valid SARIF**, even when zero findings (empty `results: []`).
  Code Scanning needs a successful upload to mark the check green.
- **Never invent past-finding links.** Cite an LF-NNN only when the
  recognition signal genuinely matches.
- **Trust fp-check's verdict.** If fp-check says FP, we drop the finding —
  even if the original tool rated it High. Cite fp-check's rationale in
  the dropped-findings count.

## Files we maintain (LI.FI-specific, MIT/LGPL)

- `audit/knowledge/` — the corpus (built by `/extract-audit-knowledge`)
- `audit/findings/waived.yml` — FP waivers; not committed empty, created on
  the first waiver (schema + process in `docs/security-review.md`). Noisy
  static-tool rules are handled by the `--exclude-*` flags or by fixing the
  Semgrep rule under `audit/knowledge/semgrep/`, not a per-finding skip list.

## Files we DO NOT maintain (vendored, CC-BY-SA-4.0)

- `.claude/vendor/tob-skills/**` — bump the submodule SHA to update.
  See `docs/security-review.md` § "Bumping ToB skills" for the procedure.

## Cost budget

| PR shape                       | Target cost (Sonnet 4.6) |
| ------------------------------ | ------------------------ |
| Small (≤5 changed files)       | $0.10–0.30               |
| Medium (6–15 files)            | $0.30–0.80               |
| Large (16–30 files)            | $0.80–1.60               |
| Huge (>30 files)               | Skipped (Step 1)         |

These are higher than the previous estimates because fp-check is a
per-finding invocation. Prompt caching of `audit/knowledge/` and the
ToB skill files brings the steady-state cost down ~70% after the first
run of the day per repo.

## Reference

- `NOTICE` — third-party attribution + license terms
- `docs/security-review.md` — operational manual (setup, waiver workflow,
  bumping the ToB submodule SHA)
- `audit/knowledge/lessons.md` — corpus index (input)
- `.claude/vendor/tob-skills/plugins/fp-check/README.md` — gate review details
- `.claude/vendor/tob-skills/plugins/differential-review/README.md` — 7-phase workflow
