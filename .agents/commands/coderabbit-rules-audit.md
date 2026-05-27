---
name: coderabbit-rules-audit
description: Quarterly manual refresh of the local CodeRabbit house-rules catalogue. Diffs the latest CodeRabbit CSV export against `.agents/rules/coderabbit-learnings/catalogue.yaml` and walks the user through accepting additions, Usage bumps, and stale-rule flags one-by-one. Opens a single PR with the accepted diff. Use when the user invokes /coderabbit-rules-audit or asks to "refresh the CodeRabbit rules" — explicitly a manual quarterly action, NOT part of /pr-ready and NOT run nightly.
usage: /coderabbit-rules-audit [--csv ~/Downloads/coderabbit_learnings.csv]
---

# CodeRabbit Rules Audit — Quarterly Refresh

> **Usage**: `/coderabbit-rules-audit` (run once per quarter — see `.agents/rules/coderabbit-learnings/AUDIT.md` for the full process).

## Purpose

The `coderabbit-house-rules` skill reads from `catalogue.yaml`. CodeRabbit's upstream "Learnings" DB keeps growing — new rules, Usage bumps on existing rules. This skill keeps our local catalogue in sync **with human review**, never auto-merging.

## When to run

- Manually, once per quarter. Calendar reminder lives on Daniel's calendar.
- **Not** as part of `/pr-ready`. **Not** scheduled. **Not** chained from `/coderabbit-house-rules`.

## Workflow

### 1. Get the latest CSV

Ask the user to download the latest CodeRabbit Learnings export to `~/Downloads/coderabbit_learnings.csv`. Confirm the file exists and has the expected header:

```text
Learning,Repository,File,Pull Request,URL,Created By,Usage,Last Used,Created At,Updated At
```

### 2. Read the existing catalogue

```bash
wc -l .agents/rules/coderabbit-learnings/catalogue.yaml
```

Record the current rule count.

### 3. Diff CSV vs catalogue

For each CSV row, compute the dedupe key the same way the original derivation did:

```text
sha1(normalize(firstSentence(Learning)) + "::" + File)
```

Then compare against existing rule ids (the auto-derived ones use that same key implicitly via their `source_refs[].pr` + title).

Bucket each CSV row into:

- **NEW** — no matching entry in catalogue.
- **USAGE_BUMP** — matching entry exists, but CSV `Usage` is significantly higher (≥ +20) than catalogue `usage_count`.
- **UNCHANGED** — Usage delta within ±20 or matching entry already higher.

Also scan the catalogue for entries whose source PR is no longer in the CSV at all (potential retirement candidates) — bucket as **STALE**.

### 4. Walk the user through each bucket

For each NEW / USAGE_BUMP / STALE item, present:

```text
[NEW] CR-NEW-001 (deployment, severity: medium)
title: "..."
file glob: deployments/*.json
source PR: #1842, Usage: 45
rationale: <first 200 chars>

Accept? [y/N]
```

Accept = append to catalogue (NEW), patch `usage_count` (USAGE_BUMP), or set `confidence: low` (STALE — never auto-delete).

Decline = skip; print one-line summary of why was offered.

### 5. Write the diff + open PR

After the walkthrough:

1. Save the updated `catalogue.yaml`.
2. Branch `chore/coderabbit-rules-audit-YYYY-QN` in a worktree.
3. Commit with summary message: `chore(rules): quarterly audit YYYY-QN — +N new, ~M usage bumps, F flagged stale`.
4. Run `/pr-ready` (no skipping — the catalogue change still goes through the same gate).
5. `gh pr create` with body including the audit summary line.

### 6. Print the audit summary

End with one line:

```text
Audit complete: +12 new, ~8 usage bumps, 3 flagged stale. Catalogue: 547 → 559 rules.
```

Daniel pastes this into the PR description for the audit history.

## Out of scope

- Scraping fresh PRs (the original derivation already covered that; only re-run that flow if the CSV format itself changes).
- Trigger-regex tuning (handle as ad-hoc PRs to `catalogue.yaml`).
- Renaming rule ids (keep stable for backlinks).
