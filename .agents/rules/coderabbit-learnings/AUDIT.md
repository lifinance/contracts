# Quarterly Audit Process — `catalogue.yaml`

Run `/coderabbit-rules-audit` once per quarter (calendar reminder lives on Daniel's `daniel@li.finance`). The skill does the heavy lifting; this doc is the human-readable description for the contributor who isn't using the skill.

## What the audit does

1. Asks you to download the latest CodeRabbit CSV export to `~/Downloads/coderabbit_learnings.csv` (or accepts a custom path).
2. Loads the current `catalogue.yaml`.
3. Diffs them:
   - **New rules in CSV** (no matching entry in catalogue).
   - **Existing rules with significantly higher Usage** (e.g. ≥ +20 since last audit).
   - **Stale rules** (in catalogue, but absent or down-Usage in CSV — possibly retired).
4. For each diff item, presents a yes/no acceptance prompt.
5. Appends accepted additions; updates accepted Usage bumps; flags stale rules with `confidence: low` rather than auto-deleting.
6. Opens a PR with the diff. `/pr-ready` runs as usual.

## Why manual, not automated

- CodeRabbit's "Learning" entries vary in quality; auto-merging would let bad rules through.
- Per-rule yes/no keeps the human in the loop on a brisk cadence (~10-15 min per quarter for ~50 candidate diffs).
- Cron-based ingestion was considered and rejected: the marginal value of weekly vs quarterly is low, and quarterly aligns with the LI.FI sprint-planning cadence.

## What's NOT in scope of the audit

- Scraping fresh PRs (the original derivation script does that one-off; the audit only ingests CSV).
- Trigger-regex tuning (do that as a separate manual review when retrieval feels noisy).
- Restructuring the catalogue (categories, severities) — those are stable; revisit yearly if at all.

## Records

The audit skill prints a one-line summary at the end (additions / updates / flagged). Capture that line in the PR description so the audit history is grep-able.
