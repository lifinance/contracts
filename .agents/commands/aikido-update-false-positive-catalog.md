---
name: aikido-update-false-positive-catalog
description: Add a new false positive pattern to the Aikido catalog (.agents/references/aikido-false-positive-catalog.md). Analyzes the flagged file to understand why the finding is a false positive, drafts a catalog entry (matches-when, ignore_reason, sast_context), shows it for confirmation, appends it, and commits. Use when Aikido flags something new on a PR that is clearly a false positive not yet in the catalog.
usage: /aikido-update-false-positive-catalog <file-path> <rule-name> — e.g. /aikido-update-false-positive-catalog script/deploy/foo.ts "NoSQL injection"
---

# Aikido Update False Positive Catalog

Adds one new pattern to `.agents/references/aikido-false-positive-catalog.md` so that `aikido-address-findings` will auto-ignore it on all future runs.

No API permissions required — reads code, writes a local file.

---

## Inputs

- **file-path**: the file Aikido flagged (required)
- **rule-name**: the Aikido rule / finding title (required)

If either input is missing, ask for it before proceeding.

---

## Step 1 — Read the flagged file

Read the file at `<file-path>`. Identify:

- What code triggered the rule (the specific call, pattern, or construct)
- Why it is safe in this codebase (internal tool, constrained inputs, trusted source, sanitizer wrapper, etc.)
- Which directory it lives in (`script/`, `tasks/`, `.claude/`, `.github/`, `src/`, etc.)

---

## Step 2 — Check for existing patterns

Read `.agents/references/aikido-false-positive-catalog.md`. Check if the finding already matches an existing pattern. If yes, tell the user which pattern covers it and stop — no duplicate needed.

---

## Step 3 — Draft the catalog entry

Draft a new entry with this structure:

```markdown
## `<pattern-slug>`

**Matches when**: <precise matching criteria — rule name keywords + file location or code construct>

**ignore_reason**:
> <one paragraph: why this is a false positive in this codebase. Name the specific function/pattern, explain where inputs come from, state the threat model constraint (internal tool / no HTTP server / constrained inputs / etc.)>

**sast_context** (UI: <Rule name> → Custom Code Context):
> <same reasoning expanded for Aikido's AutoTriage — plain language, explain all safe wrappers and input sources so the scanner can make the right call>
```

Pattern slug: lowercase, underscored, descriptive (e.g. `nosql_mongoEq`, `path_traversal_scripts`).

---

## Step 4 — Show for confirmation

Present the drafted entry and ask:

```
New catalog entry for "<rule-name>" in <file-path>:

─────────────────────────────────────
<full drafted entry>
─────────────────────────────────────

Add to catalog? (y / edit / n)
```

- `y` → proceed to step 5
- `edit` → ask what to change, redraft, loop back
- `n` → stop, nothing written

---

## Step 5 — Append and commit

Append the new entry to `.agents/references/aikido-false-positive-catalog.md` before the `## Patterns NOT auto-ignored` section.

Commit:

```
chore(security): add <pattern-slug> to false positive catalog
```

Report: "Pattern `<slug>` added. `aikido-address-findings` will auto-ignore this finding on future runs."
