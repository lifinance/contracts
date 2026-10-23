---
name: aikido-update-false-positive-catalog
description: Adds a new false-positive pattern to .agents/references/aikido-false-positive-catalog.md (matches-when, ignore_reason, sast_context) after user confirmation, so /aikido-address-findings ignores it on future runs. Use when Aikido flags a clear false positive that no catalog pattern covers.
usage: /aikido-update-false-positive-catalog <file-path> <rule-name> — e.g. /aikido-update-false-positive-catalog script/deploy/foo.ts "NoSQL injection"
---

# Aikido Update False Positive Catalog

Local file edit only — no Aikido API permissions needed. Both inputs (`file-path`, `rule-name`) are required; ask for any that is missing.

## Step 1 — Read the flagged file

Identify the construct that triggered the rule, why it is safe in this codebase (internal tool, constrained inputs, trusted source, sanitizer wrapper, …), and its directory (`script/`, `tasks/`, `.claude/`, `.github/`, `src/`, …).

## Step 2 — Check for an existing pattern

If an entry in `.agents/references/aikido-false-positive-catalog.md` already covers the finding, name it and stop.

## Step 3 — Draft the entry

```markdown
## `<pattern-slug>`

**Matches when**: <precise matching criteria — rule name keywords + file location or code construct>

**ignore_reason**:
> <one paragraph: why this is a false positive in this codebase. Name the specific function/pattern, explain where inputs come from, state the threat model constraint (internal tool / no HTTP server / constrained inputs / etc.)>

**sast_context** (UI: <Rule name> → Custom Code Context):
> <same reasoning expanded for Aikido's AutoTriage — plain language, explain all safe wrappers and input sources so the scanner can make the right call>
```

Slug: lowercase, underscored, descriptive (e.g. `nosql_mongoEq`, `path_traversal_scripts`).

## Step 4 — Confirm

Show the full drafted entry for `"<rule-name>"` in `<file-path>` and ask `Add to catalog? (y / edit / n)`. `edit` → redraft and ask again; `n` → stop with nothing written.

## Step 5 — Append and commit

Insert the entry before the `## Patterns NOT auto-ignored` section, then commit:

```text
chore(security): add <pattern-slug> to false positive catalog
```
