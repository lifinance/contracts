---
name: coderabbit-house-rules
description: Pre-flight code review using LI.FI house-rules learned from CodeRabbit. Loads the local rules catalogue, retrieves rules matching the current diff (path-glob + keyword triggers), and reviews the diff against just those rules — catching recurring patterns *before* the PR ever sees CI. Use when the user invokes /coderabbit-house-rules, when /pr-ready is running, or before any `gh pr create` / `gh pr ready`. Skip for non-code diffs (only-docs, only-lockfiles) since the catalogue is code-focused.
usage: /coderabbit-house-rules [--base origin/main] [--files <path>...]
---

# CodeRabbit House-Rules — Local Pre-Flight Review

> **Usage**: `/coderabbit-house-rules` — runs against `HEAD` vs `origin/main` by default.
>
> Also called automatically as a pre-step inside `/pr-ready`.

## Purpose

CodeRabbit produces high-signal findings on our PRs. Many of those findings repeat — the same NatSpec mistake, the same chainId-vs-CCTP-domain confusion, the same missing deployer-signature check on a `deployments/*.json` change. We've captured ~600 of those learnings in a local rules catalogue. This skill matches them against the current diff and reviews against just the relevant ones, *before* CodeRabbit sees the PR.

Goal: by the time CodeRabbit runs in CI, it finds nothing new, because the recurring patterns were already caught locally.

## When to Run

- **Mandatory** as a pre-step inside `/pr-ready` (which runs before any `gh pr create` / `gh pr ready`).
- **Standalone** invocation any time you want a fast review against the catalogue (no LLM cost beyond the matched-rules context).

## What it does

1. Reads `.agents/rules/coderabbit-learnings/catalogue.yaml`.
2. Computes `git diff origin/main...HEAD` (override via `--base <ref>` / `--files <path>...`).
3. For each changed file, matches catalogue rules in two stages:
   - **Path glob** (`applies_to.paths`) — e.g. `src/Facets/**/*.sol`, `deployments/*.json`.
   - **Trigger regex** (`applies_to.triggers`) — keyword/phrase matches inside the changed hunks. Rules with no triggers fire on path match alone.
4. Dedupes by (rule, file), caps at 40 by severity-desc + usage-desc.
5. Emits a markdown review with each finding referencing its rule id, so you can click through to `catalogue.yaml` for the full bad/good example + source PR.

## Invocation

```bash
# default — compare HEAD vs origin/main
bun .agents/scripts/coderabbit-house-rules/retrieve.ts

# explicit base
bun .agents/scripts/coderabbit-house-rules/retrieve.ts --base origin/main

# subset of files
bun .agents/scripts/coderabbit-house-rules/retrieve.ts --files src/Facets/MyFacet.sol
```

The retrieval script writes the matched rules to **stdout** (markdown) and a one-line stats blob to **stderr**. When invoked from `/pr-ready`, the matched-rules markdown is fed to you (the agent) as additional review context — you then perform an LLM review pass against just those rules, emit findings, and `/pr-ready` applies its standard Auto-apply / Ask / Reject classification on top.

## Acting on output

For each rule the retrieval engine surfaces:

1. Read the rule's `rationale`, `bad_example`, `good_example`.
2. Inspect the matched file/hunk for the pattern described.
3. If you find the anti-pattern → emit a finding with the rule id and a one-line fix suggestion.
4. If you do **not** find it (the trigger fired but the pattern isn't actually present) → silently drop the rule. False positives are expected at this layer — they don't cost anything beyond a quick read.

## Output format (your review pass)

```text
## <file path>

- **CR-0042** · medium · deployment — <one-line finding>. Suggested fix: <one-line>.
- **CR-0091** · high · security — <one-line finding>. Suggested fix: <one-line>.
```

`/pr-ready` consumes this verbatim and merges it with the upstream CodeRabbit CLI output.

## Rules catalogue

Lives at `.agents/rules/coderabbit-learnings/catalogue.yaml`. Hand-editable. Each entry:

```yaml
- id: CR-0001
  title: "..."
  category: security | correctness | gas | style | deployment | testing
  severity: low | medium | high
  applies_to:
    paths: ["src/**/*.sol", ...]
    triggers:
      - regex: "..."
        scope: hunk_or_neighborhood
  rationale: "..."
  source_refs:
    - { repo: lifinance/contracts, pr: 1715, kind: csv }
  usage_count: 27
  confidence: high | medium
```

See `.agents/rules/coderabbit-learnings/CONTRIBUTING.md` for adding a rule by hand. Quarterly refresh from the CodeRabbit CSV export happens via the separate `/coderabbit-rules-audit` skill — invoke it explicitly each quarter; it is **not** part of `/pr-ready` or this skill.

## Notes & limitations

- **No auto-fix.** This skill flags; it doesn't edit. Apply fixes through the standard `/pr-ready` Auto-apply / Ask / Reject flow.
- **Cap of 40 matched rules per review** to keep the context lean. If the cap fires, the script logs it; expand the cap by editing `retrieve.ts` if a diff legitimately needs more.
- **Trigger regex inference** for some rules is best-effort; rules with `trigger_review_needed: true` in the catalogue need a human pass.
- The catalogue is `lifinance/contracts`-specific. Don't generalize across repos without re-deriving.
