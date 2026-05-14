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
- **Linear task ID** (optional). If known from context, include in PR body.

## Workflow

### 1. Assess current state

Run `git status` and `git diff HEAD` to understand:
- Current branch name
- Staged vs unstaged changes
- Whether a remote branch / open PR already exists (`gh pr view`)

If already on a feature branch with an open PR, offer to just push + update instead.

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
- Derive a concise commit message from the diff (imperative mood, ≤72 chars subject).
- Commit:

```bash
git commit -m "$(cat <<'EOF'
<subject line>

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

### 5. Push

```bash
git push -u origin <branch-name>
```

### 6. Build PR body from template

Read `.github/pull_request_template.md` verbatim. Fill in:

- **Linear task link**: resolve in this order:
  1. **Conversation context** — look for any Linear URL or issue ID (e.g. `EXSC-123`) mentioned by the user in this session.
  2. **Linear MCP** — if not found in context, search Linear via `mcp__claude_ai_Linear__list_issues` or `mcp__claude_ai_Linear__search_documentation` using branch name / commit subject as query terms.
  3. **Not found** — print a terminal notice: `⚠ Could not find a Linear task. Provide a link (or press Enter to skip):` and wait for input. If the user skips (empty input), leave the template placeholder text as-is (`<!-- No Linear task found — add link manually if applicable -->`). Never fabricate a link.
- **Why I implemented it this way**: one short paragraph explaining the approach/rationale derived from the diff and conversation context.
- **Author checklist**: tick only items that genuinely apply:
  - `[x] I have performed a self-review of my code` — always tick
  - `[x] This pull request is as small as possible` — tick if single-concern change
  - `[x] I have added tests that cover the functionality` — tick only if tests were added
  - `[x] For new facets: ...` — tick only if a new facet was added
  - `[x] I have updated any required documentation` — tick only if docs were updated
- **Reviewer checklist**: leave all items **unchecked** (`- [ ]`).

### 7. Derive PR title

Short imperative title (≤70 chars). Match existing commit style in `git log`.

### 8. Create PR

Write body to a temp file and use the REST API pattern:

```bash
jq -Rs '{title: "<title>", body: .}' /tmp/pr-body.md > /tmp/pr-payload.json
gh api -X POST repos/lifinance/contracts/pulls --input /tmp/pr-payload.json
```

Or via `gh pr create`:

```bash
gh pr create --title "<title>" --body "$(cat /tmp/pr-body.md)"
```

Print the resulting PR URL to the user.

### 9. Offer to post for review

After the PR is created, ask:
> PR created: <url>. Want me to post it to #dev-sc-review? (`/post-pr-for-review`)

## Failure modes

- **Uncommitted secrets / sensitive files**: warn and skip those files.
- **Branch already has open PR**: surface URL, offer to push new commits instead.
- **Push rejected (non-fast-forward)**: report error; do not force-push without explicit user instruction.
- **No template found**: use minimal body with title + rationale only.
- **Linear task unknown**: leave the placeholder text from the template rather than fabricating a link.

## Notes

- Always confirm the file list before committing when there are untracked files that look unrelated to the task.
- Never amend published commits (already pushed) without explicit user instruction.
- The `Co-Authored-By` trailer attributes the commit to Claude in the GitHub UI.
