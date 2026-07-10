---
name: create-pr
description: Create a pull request for the current branch: creates a new branch if needed, commits staged/unstaged changes, pushes, and opens a PR using the repo's pull_request_template.md. Use when the user says "create PR", "open PR", "make a pull request", "push and PR", or similar. Requires a SmartContract-team (EXSC) Linear ticket — assigned and estimated — on every PR; resolves one from context or creates one (auto-assigned, proposed estimate) unless the user explicitly opts out. Leaves reviewer checklist unchecked.
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
- **Draft** (optional). When the user or a delegating skill asks for a draft PR, pass `--draft` in step 11. All other steps (template, Linear ticket, `/pr-ready`, tests) apply unchanged.
- **Linear task link or ID** (required unless the user explicitly opts out). Must be a **SmartContract-team ticket (EXSC prefix)** that is **assigned** and has an **estimate** — step 5 validates and repairs this for existing tickets and guarantees it for created ones. If known from context, include in PR body; otherwise step 5 resolves or creates one. "Explicitly opts out" means the user said in this session that this PR needs no ticket (or chose `s` at the step 5 prompt) — the absence of a known ticket is never an opt-out.

## Related conventions

This skill creates PRs. For **editing** an existing PR's title/body, follow CLAUDE.md →
"Creating and editing PRs via gh" (uses `gh api -X PATCH` with a JSON payload).

The `/pr-ready` skill (`.agents/commands/pr-ready.md`) is a mandatory pre-flight per
`.agents/rules/099-finish.md`: it runs CodeRabbit's local CLI against the branch and
resolves findings before the PR is opened. This skill integrates `/pr-ready` as step 7
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
- Else derive from the primary change. **Prefer `<type>/<lowercase-id>-<short-slug>`** when a Linear ID is already known from conversation context (e.g. `feat/exsc-327-add-foo`). Branch-name ID prefix is the most reliable trigger for Linear's GitHub auto-link.
- Fall back to slug-only (`feat/<short-slug>`, `fix/<short-slug>`, `chore/<short-slug>`) when no Linear ID exists yet. Step 5 may still resolve or create one later, in which case the branch can be renamed (`git branch -m`) before push.
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

- **Linear task link**: resolve in this order. Linear's GitHub integration creates the bidirectional auto-link (PR in the ticket's "Links" sidebar; ticket in the PR's "Linked issues" panel) only when at least one of:

  - the **branch name** contains the issue ID (e.g. `feat/exsc-327-…`, see step 2), or
  - the PR **title or body** contains a magic keyword + ID — `Fixes EXSC-327`, `Closes EXSC-327`, `Resolves EXSC-327`, or `Ref EXSC-327` (case-insensitive; use `Ref` for partial work that should not auto-close the ticket on merge).

  A bare `EXSC-327` mention in the body alone does **not** reliably trigger the link. Prefer the branch-name route; always render the body's Linear line as `Fixes <ID>` (or `Ref <ID>`) as a belt-and-braces measure. No extra Linear MCP call is needed for cross-linking once either condition is satisfied.

  1. **Conversation context** — look for any Linear URL or issue ID (e.g. `EXSC-123`) mentioned by the user in this session.
  2. **Branch-name ID prefix** — if the branch name matches `(?i)([A-Z]+-\d+)` (e.g. `feature/exsc-327-…`), look up that ID directly via the Linear MCP `list_issues` tool with `query: "<ID>"`. If found and the ID matches, use it — no further questions about which ticket to link (the validation block below still applies).
  3. **Scoped keyword search** — extract meaningful tokens from the branch name (strip `feat/`, `fix/`, `chore/`, replace `-` with space) and the commit subject. Query the Linear MCP `list_issues` tool with `team: "SmartContract"` (i.e. EXSC tickets) and the keyword string. Do **not** filter by `assignee` — tickets are often created by PMs/others.
     - **Auto-accept** the top hit only if its title shares ≥3 meaningful tokens with the branch/commit AND its status is active (`statusType: started` or `unstarted`).
     - **Ambiguous** (top hit doesn't pass the threshold, or several candidates look plausible): show the top 3 in chat with `ID — Title — status`, and ask which to link (with a "skip" option). Use `AskUserQuestion` if available; otherwise plain chat.

  **Validation (applies to any ticket resolved via routes 1–3)** — fetch it with the Linear MCP `get_issue` tool and check:

  - **Team**: must belong to the SmartContract team (EXSC prefix). A ticket from another team does not satisfy the requirement — keep it as an extra `Ref <ID>` line if relevant, but fall through to route 4 to create the EXSC ticket.
  - **Assignee**: if unassigned, assign the current user via `save_issue` with `assignee: "me"`. Never reassign a ticket that already has an assignee.
  - **Estimate**: if none is set, propose one scaled to the diff (default **1** for simple/small changes), show it to the user for adjustment, and set it via `save_issue`. Unattended runs set the proposed value directly.

  Report any repairs made (assignee/estimate) in the pre-flight summary (step 9).

  4. **Not found** — create a new Linear ticket. A ticket is **required** on every PR; proceeding without one is allowed only on an explicit user opt-out, never as a silent fallback. If the user already opted out earlier in this session, skip this prompt and use `<!-- No Linear task -->`. The consent prompt must make **both** side-effects visible up front (ticket creation + local branch rename), so the user knows exactly what they're approving with a single keystroke. Default action is **edit** so the user always sees the proposed title and the proposed new branch name before anything is created or renamed:
     - Propose in chat (filling in the placeholders with the actual derived values):

       ```
       No Linear ticket found — one is required. Create in EXSC and rename branch?
         • Ticket: team=SmartContract, title="<derived title>"
         • Assignee: <current user>   • Estimate: <proposed, default 1>
         • Branch: <current-branch>  →  <type>/<id-after-creation>-<slug>
       ```

       - `e` (default) — show the proposed title and estimate (and the resulting new branch name once an ID is allocated) and let the user adjust before either action runs.
       - `y` — create the ticket with the proposed title as-is **and** rename the branch.
       - `s` — explicit opt-out; proceed without a ticket and leave the branch as-is. If the change genuinely qualifies (typo / doc-only / dep-bump / single-line fix), suggest adding the `trivial` label so the ticket-linkage metric counts the PR as linked.
     - If running unattended (no user available to answer), create the ticket with the derived title — do **not** proceed without one.
     - On `y` / `e` (after the user confirms the edited title): call the Linear MCP `save_issue` tool with `team: "SmartContract"`, the (edited) title, a short body summarizing the change + a placeholder for the PR URL, `assignee: "me"`, and the confirmed `estimate` (default **1** for simple tasks, scaled to the diff). Use the returned ID:
       - Insert `Fixes <ID>` in the PR body's Linear section.
       - If the local branch name doesn't already contain the ID, rename it before push: `git branch -m <new-name>` (use `<type>/<lowercase-id>-<short-slug>` per step 2). The user already consented to this rename via the prompt above.
     - On `s` (explicit user opt-out) — leave the section blank with `<!-- No Linear task -->`. Never fabricate a link, and do not rename the branch.

- **Why I implemented it this way**: one short paragraph explaining the approach/rationale derived from the diff and conversation context.
- **Author checklist**: tick only items the skill has actually verified. Do not tick by default — each tick is a claim that must be checked first.
  - `[x] I have performed a self-review of my code` — tick **only after** you actually walk the full `git diff main...HEAD` and confirm: no leftover debug prints/commented-out code, no obvious bugs, no unrelated edits, no secrets/credentials, naming/style matches the surrounding code. Note any findings in the summary; if anything looks off, surface it instead of ticking.
  - `[x] This pull request is as small as possible and only tackles one problem` — tick **only after** you inspect the file list (`git diff --name-only main...HEAD`). Tick if all touched files serve a single, coherent concern. Do not tick if the branch mixes unrelated changes. Ignore commit granularity: GitHub squashes commits on merge, so fix-up / iterative commits are not a reason to withhold the tick. `/pr-ready` may also add `pr-ready: …` commits — also fine.
  - `[x] I have run /pr-ready (local CodeRabbit) on this branch and resolved (or explicitly documented) all findings` — tick **only after** step 7 (Run `/pr-ready`) reports either CLEAN or all remaining findings are documented in the PR body.
  - `[x] I have added tests that cover the functionality` — tick only if tests were actually added in this diff.
  - `[x] For new facets: ...` — tick only if a new facet was added.
  - `[x] I have updated any required documentation` — tick only if docs were updated.
- **Reviewer checklist**: leave all items **unchecked** (`- [ ]`).

### 6. Derive PR title

Short imperative title (≤70 chars). Match existing commit style in `git log`.

**Revert PRs**: the title must start with `Revert` or contain `[Revert]`.
`versionControlAndAuditCheck.yml` uses the title to exempt revert PRs from the
audit-commit-hash check (the audited commit lives in the reverted PR's history,
never in the revert PR's commit list) — a non-conforming title (e.g.
`fix: undo facet change`) blocks the merge of a genuine revert that touches
audited contracts.

### 7. Run `/pr-ready`

Run this **before** the test suite. `/pr-ready` (local CodeRabbit) can land
auto-fix commits on the branch, and any such fixes must be validated by the
tests in step 8 — running tests first would mean re-running them after
`/pr-ready` anyway.

Invoke the sibling skill `/pr-ready` (mandatory per `.agents/rules/099-finish.md`). See
`.agents/commands/pr-ready.md` for what it does and how — do not duplicate that here.

Two integration touchpoints this skill owns:

- **Checkbox**: tick the `[x] I have run /pr-ready …` item from step 5 only if `/pr-ready` reports `Re-run status: CLEAN` or `N remaining (documented)`.
- **Deferred findings**: if `/pr-ready` produced a non-empty _Deferred_ or _Rejected_ list,
  append a `## /pr-ready deferred findings` section to the PR body (under "Why I
  implemented it this way") with each item + rationale.

If `/pr-ready` errors, stop — do not push.

### 8. Run the test suite

Lint, format, typecheck, build, solhint, and secret scanning are already enforced by
`.husky/pre-commit` (and `.agents/hooks/post-edit-validate.sh`) at every commit in
steps 4 and 7. Don't repeat them here.

The one gap pre-commit deliberately leaves is **tests** (`forge build --skip test`, no
`bun test:ts`). Per `.agents/rules/099-finish.md`, run them now — against the
post-`/pr-ready` HEAD so any auto-fix commits are validated:

- **Solidity changes**: `bun test:scoped -- <path-or-match>` during iteration; full `bun test` (or `forge test --match-path` if scope is clear) before opening a PR.
- **TypeScript / JS changes**: `bun test:ts`.
- **Docs / markdown / skill files only**: skip; note `N/A` in the summary.

If anything fails, **stop and surface the failure** — do not push without explicit user
override.

### 9. Show pre-flight summary and confirm

Before pushing or opening a PR, display a summary and wait for explicit approval:

```
About to create PR on branch `<branch-name>`:
  (renamed from `<old-branch>` in step 5)        ← show only if step 5 renamed it

Commits (<N>) since main (from `git log main..HEAD --oneline`):
  • <sha>  <subject>                          ← step 4
  • <sha>  pr-ready: <subject>                ← step 7 (if any)
  ...

Files changed (<N>) (from `git diff --name-only main...HEAD`):
  • <file1>
  • <file2>
  ...
  ↑ If any file here looks unrelated to the task,
    answer `n` below and we'll split it into a separate PR.

Self-review:
  • Diff walked: <N> files, <±M> lines
  • Findings: <none / list any concerns>
  • Single-concern: <yes / no — and why>

Linear: <EXSC-ID> — assignee <name>, estimate <n>   (repairs: <none / assigned <name> / estimate set to <n>>)
  ↑ or: no ticket (explicit user opt-out)

Checks run:
  • Pre-commit hook ... PASS (enforced lint/typecheck/build/secrets at every commit)
  • /pr-ready ......... CLEAN / N remaining (documented) / N/A
  • forge test ........ PASS / FAIL / N/A
  • bun test:ts ....... PASS / FAIL / N/A

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

Append `--draft` if the Draft input was requested.

Print the resulting PR URL to the user.

### 12. Offer to post for review

After the PR is created, ask:

> PR created: <url>. Want me to post it for review? (`/post-pr-for-review`)

`/post-pr-for-review` owns the channel choice — don't name a channel here.

## Failure modes

- **Uncommitted secrets / sensitive files**: warn and skip those files.
- **Branch already has open PR**: surface URL, offer to push new commits instead.
- **Push rejected (non-fast-forward)**: report error; do not force-push without explicit user instruction.
- **No template found**: use minimal body with title + rationale only.
- **Linear task unknown**: create a new ticket (step 5, bullet 4) with `e` (default, edit title) / `y` (accept as-is) / `s` (explicit opt-out). Only on explicit opt-out, leave the section blank with `<!-- No Linear task -->`; unattended runs must create the ticket. Never fabricate a link.
- **Tests/lints fail**: stop. Surface failures to the user and do not push unless they explicitly override.
- **`coderabbit` CLI missing / auth expired / rate-limited**: surface the error from `/pr-ready` and stop. Do not push an "unreviewed" PR to bypass the step.
- **`/pr-ready` reports unresolved findings**: only allowed if each remaining item is explicitly documented in the PR body's `## /pr-ready deferred findings` section with a rationale.

## Notes

- Always confirm the file list before committing when there are untracked files that look unrelated to the task.
- Never amend published commits (already pushed) without explicit user instruction.
