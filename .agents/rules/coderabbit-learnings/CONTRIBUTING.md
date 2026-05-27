# Adding / editing rules in `catalogue.yaml`

The catalogue is hand-editable. The `/coderabbit-house-rules` skill reads it directly at retrieval time; no codegen step required after edits.

## Schema (per rule)

```yaml
- id: CR-XXXX                       # unique; CR-NNNN for derived, otherwise free
  title: "One-line summary"
  category: security | correctness | gas | style | deployment | testing
  severity: low | medium | high
  applies_to:
    paths:
      - "src/**/*.sol"              # globs; ** and *; multiple paths OR-d
    triggers:                       # optional — omit for path-only rules
      - regex: "\\bsomePattern\\b"
        scope: hunk_or_neighborhood
  bad_example: |                    # optional
    contract Bad {}
  good_example: |                   # optional
    contract Good {}
  rationale: |                      # required — why this matters
    The reason this rule exists.
  source_refs:
    - repo: lifinance/contracts
      pr: 1715
      kind: csv | scrape | both | manual
  usage_count: 27                   # null for hand-added rules
  confidence: low | medium | high
```

## Adding a rule by hand

1. Pick a fresh `id` (e.g. `CR-MANUAL-001` for the first manual rule).
2. Drop the rule into `catalogue.yaml` (alphabetical or appended — order doesn't matter for retrieval).
3. Run a quick sanity check:

   ```bash
   bun .agents/scripts/coderabbit-house-rules/retrieve.ts --base origin/main
   ```

4. Open a PR. `/pr-ready` runs as usual.

## Editing a rule

Just edit in place. Increment `confidence` if you've seen the pattern several times in CodeRabbit's actual findings.

## Removing a rule

Delete the entry. If you're not sure, set `severity: low` and `confidence: low` instead — the retrieval engine still loads it but the LLM will tend to drop noisy low-severity matches.

## When the catalogue gets noisy

Run the quarterly audit:

```bash
/coderabbit-rules-audit
```

That skill diffs the latest CodeRabbit CSV export against the catalogue and proposes additions/updates one rule at a time.
