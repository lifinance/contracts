---
name: extract-audit-knowledge
description: Distill an existing audit PDF into the audit/knowledge/ corpus (findings.json + lessons.md + by-area/*.md). Use to seed or update the security-review knowledge base from /audit/reports/.
usage: /extract-audit-knowledge <audit_id>
---

# Extract Audit Knowledge

> **Usage**: `/extract-audit-knowledge <audit_id>` (e.g. `/extract-audit-knowledge audit20250305`).
> If `audit_id` is omitted, ask the user which audit to process.

## Overview

Distills a single audit report PDF into the structured knowledge corpus under `audit/knowledge/`. The corpus is consumed by:

- The PR-time security review skill — `lessons.md` + relevant `by-area/*.md` loaded as cached LLM context
- Future Semgrep rule generation — `findings.json` as the structured rule source
- Human reviewers — markdown files browsable in repo

**v1 scope: single-PDF mode only.** Batch processing of the entire corpus is a manual loop over audits, or a future v2 of this skill.

## Output files (under `audit/knowledge/`)

| File                                                                       | Source of truth? | Hand-edited?                  |
| -------------------------------------------------------------------------- | ---------------- | ----------------------------- |
| `findings.json`                                                            | Yes (canonical)  | Additive only via this skill  |
| `lessons.md`                                                               | Generated        | No                            |
| `by-area/{facets,periphery,libraries,security,helpers,cross-cutting}.md`   | Generated        | No                            |

The two markdown surfaces are projections regenerated from `findings.json` on every run. Never hand-edit them.

## Inputs

- `audit/auditLog.json` — resolves the audit ID's PDF path and metadata
- `audit/reports/<filename>.pdf` — the audit report being distilled
- `audit/knowledge/findings.json` — existing corpus to merge into (if present)

## Schema reference

See section [Finding schema](#finding-schema) at the bottom of this file for the full data model.

## Execution steps

### 1. Resolve target audit

- Parse `audit/auditLog.json`; locate the `audits.<audit_id>` entry
- Extract: `auditReportPath`, `auditedBy`, `auditCompletedOn`, `auditCommitHash`
- Fail with a clear error if `audit_id` not found in the log

### 2. Read PDF in 20-page windows

- Use `Read` with `pages: "1-20"`, then `pages: "21-40"`, … until end of PDF
- Skip front matter (researcher bio, disclaimer, risk-classification tables — typically pages 1-3)
- The findings section is conventionally headed `Findings` or `Issues Found`
- Record page numbers for each extracted finding (the printed footer number, not file-index)

### 3. Apply the skip list

Before extracting any finding, decide whether to keep it. Filtering at this stage prevents corpus bloat that degrades downstream LLM context efficiency.

**Skip (do not extract):**

- Gas optimizations
- Naming, NatSpec, formatting issues
- Code-quality / style / consistency informational items with **no security path** (e.g. "use `isNativeAsset()` instead of `address(0)`")
- Compiler/linter advisories

**Keep:**

- Critical / High / Medium / Low severity (all)
- Informational items with a security-relevant impact (e.g. missing event emissions on admin actions, partial access-control checks)

**When in doubt:** ask "Does this finding describe a way that funds could be lost, frozen, stolen, or operations halted, even hypothetically?" If yes → keep. If no → skip.

This skip criterion is deliberately strict — don't relax it without good reason.

### 4. Extract fields

For each kept finding, extract:

- `title` — single-sentence headline. Rewrite the auditor's title only if unclear or generic
- `severity` — normalized: `critical | high | medium | low | info`
- `severity_native` — auditor's original label (preserves auditor-specific scales)
- `area` — `facets | periphery | libraries | security | helpers | cross-cutting`. Use `cross-cutting` only when the finding touches ≥ 2 areas in non-trivial ways
- `contracts` — Solidity contract names; must match keys in `audit/auditLog.json#auditedContracts`
- `root_cause` — ≤3 sentences, in mechanism terms (why the bug exists), not symptom
- `fix_summary` — ≤2 sentences. Cite commit hash if the PDF includes one (`LI.FI: Fixed in <hash>`)
- `recognition_signal` — single sentence, pattern-ish, useful for matching against new code. Drop the bug specifics; describe the **shape** (see golden sample below)
- `status` — derive from the "LI.FI:" + "Researcher:" lines at end of finding. One of: `raised | acknowledged | fixed | wont_fix | mitigated | reopened`
- `tags` — free-form classifiers (`non-evm`, `eth-transfer`, `reentrancy`, `access-control`, …)
- `source.pages` — exact PDF pages this finding spans

### 5. Assign LF-NNN IDs

- Find the highest existing `LF-NNN` in `audit/knowledge/findings.json` (if the file exists); increment from there
- `source_id` is the composite `<audit_id>::<auditor_label>`, where `auditor_label` is the section number (e.g. `6.1.1`) when available, else the auditor's label (`H-1`, `Issue 14`)
- Prefer section numbers — they are unambiguous within a single audit

### 6. Apply idempotency

Before inserting a finding, compute its `source_id` (`<audit_id>::<auditor_label>`) and search the existing corpus. A finding from this audit run is considered "already processed" if **either** of these matches:

- An existing finding's top-level `source_id` equals the computed `source_id` (i.e., the same audit's first-occurrence is already on file), OR
- An existing finding's `status_history` contains an entry whose reconstructed composite `<audit_id>::<source_label>` equals the computed `source_id` (i.e., this audit's appearance is recorded under a re-audit history of some other finding)

If either matches → **skip insertion** of a new entry. Instead, append a new `status_history` entry to the matching finding (Step 7, "Existing finding").

If neither matches → new entry (Step 7, "New finding").

Re-running the skill on the same audit therefore produces no spurious diffs: each `status_history` row already carries `audit_id` + `source_label`, which reconstruct the exact composite key used for comparison.

### 7. Merge into corpus

For each in-scope finding:

- **New finding** (no `source_id` match anywhere): assign next `LF-NNN`, write a full entry, status_history has one row
- **Existing finding** (some entry's `status_history` already references this `source_id`): append a new `status_history` row to that entry. Do NOT create a new `LF-NNN`. Update top-level `severity` only if the new appearance has higher severity than the recorded one
- **Cross-audit echo** (same root cause appears in two audits under different `source_id`s): do NOT auto-merge. Log a warning to console; let the human decide via follow-up edit. Auto-merging is a future v2 enhancement

### 8. Record processing in `processed_audits`

Append the audit's ID to `findings.json`'s top-level `processed_audits` array (schema 1.1+). This MUST happen even when zero findings were kept — the array records "we considered this audit", so the coverage check (`script/tasks/checkAuditKnowledgeCoverage.ts`) stops flagging zero-finding audits as drift.

- Read `findings.json#processed_audits` (initialize to `[]` if missing)
- If `audit_id` is not present, append it; keep the array sorted
- If `audit_id` is already present (re-run), no-op (idempotent)

### 9. Regenerate projections

After `findings.json` is updated, regenerate the markdown surfaces:

- **`lessons.md`** — totals tables + flat index of every finding
- **`by-area/<area>.md`** — for each area that has at least one finding, write a file with all entries in that area, sorted severity-descending. Do not write files for areas with zero findings (downstream loaders should handle the missing file gracefully)

### 10. Summary output

Print to console:

- Counts: added / updated / skipped (with a one-line reason for each skipped item)
- Confidence breakdown: high / medium / low
- File diff summary (lines added per output file)
- Spot-check list: 3 random findings for the user to verify by eye

## Validation checklist

Before finalizing the skill's output:

- [ ] All required fields present per schema
- [ ] Every `LF-NNN` ID is unique and monotonically increasing
- [ ] Every `source_id` is unique across the corpus
- [ ] Every finding cites at least one page from the source PDF
- [ ] No skipped categories slipped through (verify a sample)
- [ ] `audit_id` appended to `findings.json#processed_audits` (Step 8) regardless of findings count
- [ ] `lessons.md` totals match actual finding counts
- [ ] `by-area/*.md` files contain only findings tagged with that area
- [ ] `findings.json` is valid JSON (no trailing commas, well-formed strings)
- [ ] Re-running the skill on the same audit produces no diff (idempotency check)

## Finding schema

```jsonc
{
  "schema_version": "1.1",
  "generated_at": "<ISO-8601 UTC>",
  // Schema 1.1+: every audit_id we've considered (with or without findings).
  // The coverage check uses this to distinguish "we looked and found nothing"
  // from "we never looked". Sorted lexicographically; idempotent on re-run.
  "processed_audits": ["audit20240201", "audit20240814", "audit20240902", ...],
  "findings": {
    "LF-001": {
      "id": "LF-001",
      "source_id": "audit20250305::6.1.1",
      "title": "<single sentence>",
      "severity": "critical | high | medium | low | info",
      "area": "facets | periphery | libraries | security | helpers | cross-cutting",
      "contracts": ["ContractName1", "ContractName2"],
      "root_cause": "<≤3 sentences>",
      "fix_summary": "<≤2 sentences>",
      "recognition_signal": "<single sentence, pattern-shaped>",
      "status_history": [
        {
          "audit_id": "audit20250305",
          "source_label": "6.1.1",
          "status": "raised | acknowledged | fixed | wont_fix | mitigated | reopened",
          "severity_native": "<auditor's original label>",
          "notes": "<optional, e.g. 'Verified fix in commit <hash>'>"
        }
      ],
      "source": {
        "pdf": "<filename relative to audit/reports/>",
        "pages": [<int>, ...]
      },
      "extraction_confidence": "high | medium | low",
      "tags": ["<free-form>"]
    }
  }
}
```

## Golden sample

The canonical reference example is `audit20250305` (Chainflip Facet audit, March 2025):

- 7 raw findings in the PDF → 3 kept (1 high, 2 low) + 4 skipped (1 gas, 3 code-quality informational)
- Demonstrates: all kept-severity tiers, both `facets` and `periphery` areas, `fixed` + `acknowledged` statuses
- Page citations: LF-001 (p.5), LF-002 (p.5-6), LF-003 (p.6-7)

When implementing this skill, validate against the hand-built golden sample before committing.

## Implementation notes

- Use Claude's native PDF reading via the `Read` tool (no external libraries)
- For PDFs >20 pages, batch reads sequentially in 20-page windows
- `source.pages` refers to the printed page number in the PDF footer, not the file-index page
- PDFs sometimes introduce non-breaking spaces or line-wrapping artifacts in code blocks — be lenient when matching extracted text
- The skill performs READ + WRITE operations only on files under `audit/knowledge/` and `audit/auditLog.json`. It must never modify `audit/reports/*.pdf`

## Out of scope for v1

- Batch / `--all` mode that walks all audits in `auditLog.json` (deferred to v2 or done manually)
- Sub-agent fan-out for parallel extraction
- Auto-suggestion of cross-audit echoes via embedding similarity
- Per-field confidence scoring (currently per-finding only)

## Related rules and skills

- `.agents/rules/501-audits.md` — audit log structure and naming conventions
- `.agents/commands/add-audit.md` — the existing `/add-audit` skill that registers new audits in `auditLog.json` (this skill consumes its output)
- `.agents/commands/review-bounty-report.md` — sibling skill for triaging Cantina bug-bounty submissions
