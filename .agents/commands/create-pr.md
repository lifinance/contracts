---
name: create-pr
description: "Commits, pushes and opens a PR for the current branch from .github/pull_request_template.md, creating a branch if needed. Requires an assigned, estimated EXSC Linear ticket — resolves or creates one unless the user opts out. Use for \"create PR\", \"open PR\", \"push and PR\"."
---

# Create PR

## Inputs

- **Branch name** (optional). If omitted, derive from staged changes or task context.
- **Commit message** (optional). If omitted, derive from the diff.
- **Draft** (optional). When the user or a delegating skill asks for a draft PR, pass `--draft` in step 10. All other steps apply unchanged.
- **Linear task link or ID** (required unless the user explicitly opts out). Must be a **SmartContract-team ticket (EXSC prefix)** that is **assigned** and has an **estimate**. "Explicitly opts out" means the user said in this session that this PR needs no ticket (or chose `s` at the step 4 prompt) — the absence of a known ticket is never an opt-out.

To **edit** an existing PR's title/body, follow `.agents/context.md` → "Creating and editing PRs via gh".

## Workflow

### 1. Assess current state

`git status`, `git diff HEAD`, `gh pr view`. Before continuing:

- **No changes** (clean tree and `git log main..HEAD` empty): abort — nothing to PR.
- **Detached HEAD**: abort and ask the user to check out a branch.
- **Feature branch with an open PR**: surface its URL and offer to commit + push to it instead of opening a new one; on yes, run steps 3–9 as usual, then print that URL instead of step 10.
- **On `main`/`master`**: require a new branch; never commit to a protected branch.

### 2. Branch

- If the user supplied a name, use it exactly (`git checkout -b`, or switch to it if it exists).
- Else prefer `<type>/<lowercase-id>-<short-slug>` when a Linear ID is already known (e.g. `feat/exsc-327-add-foo`) — the ID in the branch name is the most reliable trigger for Linear's GitHub auto-link.
- Otherwise `<type>/<short-slug>`; step 9 may rename it once a ticket exists.

### 3. Stage and commit

Stage only files relevant to the task — never `git add -A` blindly; skip unrelated untracked files and confirm the list with the user when any look unrelated. Match the subject style of recent `git log` entries (e.g. `chore(skills): …`).

### 4. Resolve the Linear ticket

Linear auto-links PR and ticket only when the **branch name** contains the ID, or the PR title/body has `Fixes|Closes|Resolves|Ref <ID>` (`Ref` for partial work — no auto-close on merge); a bare ID in the body does not reliably link. Render the body's Linear line as `Fixes [<ID>](<ticket URL>)` (or `Ref …`), using the `url` from the Linear MCP.

Resolve in order:

1. **Conversation context** — a Linear URL or ID the user mentioned this session.
2. **Branch-name ID** — if the branch matches `(?i)([A-Z]+-\d+)`, look it up via Linear MCP `list_issues` with `query: "<ID>"`; if the ID matches, use it without further questions (validation still applies).
3. **Scoped keyword search** — tokens from the branch name (strip the type prefix, `-` → space) and commit subject; `list_issues` with `team: "SmartContract"`. Do **not** filter by `assignee` — tickets are often created by PMs/others.
   - **Auto-accept** the top hit only if its title shares ≥3 meaningful tokens with the branch/commit AND its `statusType` is `started` or `unstarted`.
   - Otherwise show the top 3 as `ID — Title — status` and ask which to link, with a "none of these" option that falls through to route 4 (not an opt-out). Use `AskUserQuestion` if available.

**Validation** (routes 1–3) — `get_issue` and check:

- **Team**: must be SmartContract (EXSC). A ticket from another team doesn't satisfy the requirement — keep it as an extra `Ref <ID>` line if relevant and fall through to route 4.
- **Assignee**: if unassigned, plan to assign the current user (`assignee: "me"`). Never reassign an assigned ticket.
- **Estimate**: if none, propose one scaled to the diff (default **1** for small changes).

Do not write to Linear yet — planned repairs go in the step 8 pre-flight and run in step 9. Unattended runs apply the proposed values in step 9.

4. **Not found** — a ticket is required; proceed without one only on explicit opt-out (if the user already opted out this session, skip the prompt and use `<!-- No Linear task -->`). The prompt must show both side-effects — ticket creation and branch rename:

   ```text
   No Linear ticket found — one is required. Create in EXSC and rename branch?
     • Ticket: team=SmartContract, title="<derived title>"
     • Assignee: <current user>   • Estimate: <proposed, default 1>
     • Branch: <current-branch>  →  <type>/<id-after-creation>-<slug>
   ```

   - `e` (default) — let the user adjust title and estimate before anything runs.
   - `y` — accept as proposed.
   - `s` — explicit opt-out: no ticket, branch unchanged, body line `<!-- No Linear task -->`; never fabricate a link. If the change is genuinely trivial (typo / doc-only / dep-bump / single-line fix), suggest the `trivial` label so the ticket-linkage metric counts it.
   - Unattended: plan the ticket with the derived title — never proceed without one.

   On `y` / `e`, record the planned ticket. Step 9 creates it with `save_issue`: `team: "SmartContract"`, the title, a short body summarizing the change plus a PR-URL placeholder, `assignee: "me"`, and the confirmed `estimate`.

### 5. Build the PR body

Read `.github/pull_request_template.md` verbatim and fill in:

- **Linear task**: per step 4.
- **Why I implemented it this way**: one short paragraph of rationale. Write body prose **unwrapped** (one paragraph = one line) — GitHub renders single newlines in PR bodies as hard breaks.
- **Author checklist**: each tick is a claim — tick only what you verified:
  - Self-review — only after walking the full `git diff main...HEAD`: no debug prints/commented-out code, no obvious bugs, no unrelated edits, no secrets, naming/style matches surrounding code. Surface findings instead of ticking.
  - Small / one problem — only after `git diff --name-only main...HEAD` shows a single coherent concern. Ignore commit granularity (PRs are squash-merged).
  - Tests added / new facet / docs updated — only if this diff actually does so.
- **Reviewer checklist**: leave every item unchecked.

### 6. Title

Imperative, ≤70 chars, matching `git log` style.

### 7. Run tests

`.husky/pre-commit` and `.agents/hooks/post-edit-validate.sh` already enforce lint, format, typecheck, build, solhint and secret scanning at commit time. The gap is **tests** (pre-commit uses `forge build --skip test` and skips `bun test:ts`):

- **Solidity**: `bun test:scoped -- <path-or-match>` while iterating; full `bun run test` (or `forge test --match-path` if scope is clear) before opening the PR.
- **TypeScript/JS**: `bun test <path>` while iterating; full `bun test:ts` before opening the PR.
- **Docs / markdown / skill files only**: skip; report `N/A`.

On failure, stop and surface it — do not push without explicit user override.

### 8. Pre-flight summary — wait for approval

```text
About to create PR on branch `<branch-name>`:
  (renamed to `<new-branch>` in step 9)          ← only if step 4 planned a rename

Commits (<N>) since main (`git log main..HEAD --oneline`):
  • <sha>  <subject>

Files changed (<N>) (`git diff --name-only main...HEAD`):
  • <file>
  ↑ If any file looks unrelated, answer `n` and we'll split it into a separate PR.

Self-review:
  • Diff walked: <N> files, <±M> lines
  • Findings: <none / concerns>
  • Single-concern: <yes / no — why>

Linear: <EXSC-ID> — assignee <name>, estimate <n>   (planned repairs: <none / assign / set estimate>)
  ↑ or: new ticket "<title>", estimate <n>, branch → <new-branch>   (created in step 9)
  ↑ or: no ticket (explicit user opt-out)

Checks run:
  • Pre-commit hook ... PASS
  • forge test ........ PASS / FAIL / N/A
  • bun test:ts ....... PASS / FAIL / N/A

PR title: <title>

PR body:
─────────────────────────────────────────
<full filled-in PR body>
─────────────────────────────────────────

Proceed? (y/n)
```

On **n**: ask what to change and loop back — no push, no Linear writes.

### 9. Apply Linear changes, then push

Run the planned Linear writes (create the ticket, or apply assignee/estimate repairs), fill the ticket link into the body, and rename the branch (`git branch -m <type>/<lowercase-id>-<slug>`) if planned — the user consented in step 4. Then `git push -u origin <branch-name>`.

### 10. Create the PR

Write the body to the session scratchpad (not a shared `/tmp` path — parallel sessions overwrite each other there):

```bash
gh pr create --title "<title>" --body-file <scratchpad>/pr-body.md --base main --head <branch-name>
```

Append `--draft` if requested. If step 9 created the ticket, replace its PR-URL placeholder with the returned URL (`save_issue` with `id` and a `patch`). Print the PR URL.

### 11. Offer to post for review

> PR created: <url>. Want me to post it for review? (`/post-pr-for-review`)

`/post-pr-for-review` owns the channel choice — don't name a channel here.

## Failure modes

- **Secrets / sensitive files in the diff**: warn and skip those files.
- **Push rejected (non-fast-forward)**: report; never force-push without explicit instruction.
- **No template found**: minimal body with title + rationale.
