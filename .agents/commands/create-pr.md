---
name: create-pr
description: "Commits the current work, runs build and tests, and opens a PR from .github/pull_request_template.md linked to its EXSC Linear ticket, then hands off to drive-pr. Use for \"create PR\", \"open PR\", \"push and PR\", or from a skill that needs a PR opened."
---

# Create PR

Never pause for the user except on a stop below or the step 2 question.

## Inputs

- **Linear ID or URL** (optional): overrides the ID in the branch name.
- **Commit message / PR title** (optional): otherwise derived from the diff, in recent `git log` style.
- **Base branch** (optional): `main` unless the user names another (a stacked PR).
- **Called from another skill**: the caller supplies the files to stage, the title/commit message and the body "Why", and optionally a Linear ID and a partial-work flag. This path asks no questions and ends after step 6.

## Workflow

### 1. Assess state

`git status`, `git log main..HEAD`, `gh pr view`.

- **Nothing to PR** (clean tree and `git log main..HEAD` empty) or **detached HEAD**: stop.
- **On `main`/`master`**: never commit to it or rename it. Branch first: `git checkout -b <type>/exsc-<N>-<slug>` when the ID is known, else `<type>/<slug>`, which step 2's "create" renames.
- **Branch has an open PR**: run steps 2–5, push, then update its title and body per `.agents/context.md` "Creating and editing PRs via gh" instead of step 6. Keep its "Why" unless the caller supplies one.

### 2. Resolve the ticket

Use the supplied ID, else the `exsc-<N>` in the branch name, and `get_issue` it for its `url`. A missing, unknown or non-EXSC ID counts as no ID; keep a non-EXSC ticket as an extra `Ref` line. With no ID, and unless the user already opted out this session, ask the user to:

- provide one, or
- create one: run `/start-linear-ticket --existing-branch` with a title derived from the diff, or
- opt out: the Linear line becomes `<!-- No Linear task -->`; suggest the `trivial` label for a typo, doc-only, dep-bump or single-line PR.

Unattended and called runs never ask; they create one.

### 3. Commit

Stage only the files of this work, or exactly the files the caller names — never `git add -A`. Leave out secrets and unrelated files and report them. Skip when everything is already committed.

### 4. Test

Pre-commit covers lint, format and typecheck, not build or tests. On failure, stop and report it; do not push.

- **Solidity**: `bun run test`, or `forge test --match-path <path>` when the scope is clear.
- **TypeScript/JS**: `bun test:ts`.
- **Docs, markdown or skill files only**: N/A.

### 5. Write title and body

Title: imperative, ≤70 chars, `git log` style. Body: `.github/pull_request_template.md` verbatim (missing → stop), filled in:

- **Linear task**: `Fixes [<ID>](<url>)`, or `Ref [<ID>](<url>)` when the caller marks the PR as partial work, so merging does not close the ticket.
- **Why**: one short paragraph on one line; GitHub renders single newlines in PR bodies as hard breaks.
- **Author checklist**: tick only what you verified. Self-review: after walking the full `git diff <base>...HEAD`. Small / one problem: the diff has a single concern. Tests, new facet, docs: only if this diff does so.
- **Reviewer checklist**: leave every item unchecked.

### 6. Open the PR

`git push -u origin <branch>`; if it is rejected, stop — never force-push. Write the body to the session scratchpad, open the PR and print its URL. CI converts every new PR to draft.

```bash
gh pr create --title "<title>" --body-file <scratchpad>/pr-body.md --base <base> --head <branch>
```

### 7. Hand off

- **Invoked by the user**: run `/drive-pr <N>`.
- **Called from another skill**: return the PR URL and stop. The caller decides when the PR leaves draft.
