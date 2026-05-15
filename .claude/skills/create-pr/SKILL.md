---
name: create-pr
description: Create a pull request for the current branch: creates a new branch if needed, commits staged/unstaged changes, pushes, and opens a PR using the repo's pull_request_template.md. Use when the user says "create PR", "open PR", "make a pull request", "push and PR", or similar. Fills in Linear task link and implementation rationale from context; leaves reviewer checklist unchecked.
---

# Create PR

## When to trigger

User says any of:
- "create PR" / "open PR" / "make a pull request"
- "push and create PR" / "commit, push and PR"
- "new branch, commit, push and PR"
- `/create-pr [branch-name]`

## Inputs

- **Branch name** (optional). If omitted, derive from staged changes or task context (e.g. `feat/short-description`).
- **Commit message** (optional). If omitted, derive from the diff.
- **Linear task link or ID** (optional). If known from context, include in PR body.

## Related conventions

This skill creates PRs. For **editing** an existing PR's title/body, follow CLAUDE.md →
"Creating and editing PRs via gh" (uses `gh api -X PATCH` with a JSON payload).

The `/pr-ready` skill (`.agents/commands/pr-ready.md`) is a mandatory pre-flight per
`.agents/rules/099-finish.md`: it runs CodeRabbit's local CLI against the branch and
resolves findings before the PR is opened. This skill integrates `/pr-ready` as step 8
below.

## Workflow

### 1. Assess current state

Run `git status` and `git diff HEAD` to understand:
- Current branch name
- Staged vs unstaged changes
- Whether a remote branch / open PR already exists (`gh pr view`)

Handle these edge cases before continuing:
- **No changes (clean tree, no staged diff)**: abort with a clear message. There's nothing to PR.
- **Detached HEAD**: abort and ask the user to check out a branch first.
- **Already on a feature branch with an open PR**: offer to just commit + push + update the existing PR instead of opening a new one.
- **On `main`/`master` with local changes**: require a new branch (step 3); never commit to a protected branch.

### 2. Determine branch name

- If user supplied one, use it exactly.
- Else derive from the primary change: `feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`.
- Never commit directly to `main` or `master` — create a new branch.

### 3. Create branch (if needed)

```bash
git checkout -b <branch-name>
```

If branch already exists locally, switch to it (`git checkout <branch-name>`).

### 4. Stage and commit

- Stage only the files relevant to the task. **Never** `git add -A` blindly — check for unrelated untracked files first and skip them.
- Derive a concise commit message from the diff (imperative mood, ≤72 chars subject); match the style of recent `git log` entries (e.g. `chore(skills): …`).

```bash
git commit -m "<subject line>"
```

### 5. Build PR body from template (locally, before pushing)

Read `.github/pull_request_template.md` verbatim. Fill in:

- **Linear task link**: resolve in this order:
  1. **Conversation context** — look for any Linear URL or issue ID (e.g. `EXSC-123`) mentioned by the user in this session.
  2. **Linear MCP** — if not found in context, search Linear via `mcp__claude_ai_Linear__list_issues` or `mcp__claude_ai_Linear__search_documentation` using branch name / commit subject as query terms.
  3. **Not found** — ask the user directly in chat for a Linear link, making clear they can skip (e.g. "No Linear task found. Paste a link, or say 'skip' if this PR has no associated ticket."). If they skip, leave the section blank with a brief HTML comment placeholder (`<!-- No Linear task -->`). Never fabricate a link. (Prefer `AskUserQuestion` if available; otherwise ask in conversation.)
- **Why I implemented it this way**: one short paragraph explaining the approach/rationale derived from the diff and conversation context.
- **Author checklist**: tick only items the skill has actually verified. Do not tick by default — each tick is a claim that must be checked first.
  - `[x] I have performed a self-review of my code` — tick **only after** you actually walk the full `git diff main...HEAD` and confirm: no leftover debug prints/commented-out code, no obvious bugs, no unrelated edits, no secrets/credentials, naming/style matches the surrounding code. Note any findings in the summary; if anything looks off, surface it instead of ticking.
  - `[x] This pull request is as small as possible and only tackles one problem` — tick **only after** you inspect the commit list (`git log main..HEAD --oneline`) and the file list. Tick if all commits serve a single, coherent concern. Do not tick if the branch mixes unrelated changes, or if it contains iterative fix-up commits that should be squashed (call those out to the user before deciding). Note: `/pr-ready` legitimately introduces additional `pr-ready: …` commits — those do not invalidate "single concern".
  - `[x] I have run /pr-ready (local CodeRabbit) on this branch and resolved (or explicitly documented) all findings` — tick **only after** step 8 (Run `/pr-ready`) reports either CLEAN or all remaining findings are documented in the PR body.
  - `[x] I have added tests that cover the functionality` — tick only if tests were actually added in this diff.
  - `[x] For new facets: ...` — tick only if a new facet was added.
  - `[x] I have updated any required documentation` — tick only if docs were updated.
- **Reviewer checklist**: leave all items **unchecked** (`- [ ]`).

### 6. Derive PR title

Short imperative title (≤70 chars). Match existing commit style in `git log`.

### 7. Run the test suite

Lint, format, typecheck, build, solhint, and secret scanning are already enforced by
`.husky/pre-commit` (and `.agents/hooks/post-edit-validate.sh`) at the commit in step 4.
Don't repeat them here.

The one gap pre-commit deliberately leaves is **tests** (`forge build --skip test`, no
`bun test:ts`). Per `.agents/rules/099-finish.md`, run them now:

- **Solidity changes**: `forge test` (or `forge test --match-path` if scope is clear).
- **TypeScript / JS changes**: `bun test:ts`.
- **Docs / markdown / skill files only**: skip; note `N/A` in the summary.

If anything fails, **stop and surface the failure** — do not push without explicit user
override.

### 8. Run `/pr-ready`

Invoke the sibling skill `/pr-ready` (mandatory per `.agents/rules/099-finish.md`). See
`.agents/commands/pr-ready.md` for what it does and how — do not duplicate that here.

Two integration touchpoints this skill owns:

- **Checkbox**: tick the `[x] I have run /pr-ready …` item from step 5 only if `/pr-ready`
  reports `Re-run status: CLEAN` or `N remaining (documented)`.
- **Deferred findings**: if `/pr-ready` produced a non-empty *Deferred* or *Rejected* list,
  append a `## /pr-ready deferred findings` section to the PR body (under "Why I
  implemented it this way") with each item + rationale.

If `/pr-ready` errors, stop — do not push.

### 9. Show pre-flight summary and confirm

Before pushing or opening a PR, display a summary and wait for explicit approval:

```
About to create PR on branch `<branch-name>`:

Files committed (<N>):
  • <file1>
  • <file2>
  ...

Commit: "<commit message>"

Self-review:
  • Diff walked: <N> files, <±M> lines
  • Findings: <none / list any concerns>
  • Single-concern: <yes / no — and why>

Checks run:
  • Pre-commit hook ... PASS (enforced lint/typecheck/build/secrets at step 4)
  • forge test ........ PASS / FAIL / N/A
  • bun test:ts ....... PASS / FAIL / N/A
  • /pr-ready ......... CLEAN / N remaining (documented) / N/A

/pr-ready commits added (<N>):
  • <short-sha>  <file>:<line>  <one-line issue summary>
  ...

PR title: <title>

PR body:
─────────────────────────────────────────
<full filled-in PR body>
─────────────────────────────────────────

Proceed? (y/n)
```

If the user says **n**: ask what to change (title, body, files) and loop back. Do not push.
If the user says **y**: proceed to steps 10–12.

### 10. Push

```bash
git push -u origin <branch-name>
```

### 11. Create PR

Write body to a temp file and create via `gh`:

```bash
gh pr create --title "<title>" --body "$(cat /tmp/pr-body.md)" --base main --head <branch-name>
```

Print the resulting PR URL to the user.

### 12. Offer to post for review

After the PR is created, ask:
> PR created: <url>. Want me to post it to #dev-sc-review? (`/post-pr-for-review`)

## Failure modes

- **Uncommitted secrets / sensitive files**: warn and skip those files.
- **Branch already has open PR**: surface URL, offer to push new commits instead.
- **Push rejected (non-fast-forward)**: report error; do not force-push without explicit user instruction.
- **No template found**: use minimal body with title + rationale only.
- **Linear task unknown**: leave the section blank with an HTML comment (`<!-- No Linear task -->`) rather than fabricating a link.
- **Tests/lints fail**: stop. Surface failures to the user and do not push unless they explicitly override.
- **`coderabbit` CLI missing / auth expired / rate-limited**: surface the error from `/pr-ready` and stop. Do not push an "unreviewed" PR to bypass the step.
- **`/pr-ready` reports unresolved findings**: only allowed if each remaining item is explicitly documented in the PR body's `## /pr-ready deferred findings` section with a rationale.

## Notes

- Always confirm the file list before committing when there are untracked files that look unrelated to the task.
- Never amend published commits (already pushed) without explicit user instruction.
