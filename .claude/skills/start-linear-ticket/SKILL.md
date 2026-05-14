---
name: start-linear-ticket
description: Start work on a Linear ticket — fetches the issue, creates a properly-named local git branch in the right repo, moves the ticket to "In Progress", and assigns it to the current user. Use when the user says "start ticket", "start linear ticket", "begin work on EXSC-XXX", "/start-ticket", "let's start <ID>", or supplies a Linear issue ID/URL with intent to begin work. Mirrors the "Create branch" button from Jira, but also handles the status flip and ownership claim in one step — designed for orgs where PR-auto-assign is off but starting work is the right moment to claim a ticket. Requires the Linear MCP server. Skip if the user is just asking about a ticket (read intent) rather than starting work, or if the ticket is already In Progress and has a linked branch — in that case just show the existing branch.
---

# Start Linear Ticket

## When to trigger

User says any of:
- "start ticket EXSC-282" / "start linear ticket" / "start <ID>"
- "begin work on <ID>" / "let's start <ID>" / "pick up <ID>"
- `/start-ticket <ID-or-URL>`
- Pastes a Linear issue URL or ID and signals intent to begin work (e.g. "starting this now: https://linear.app/...")

Do NOT trigger on read-only intents ("what's EXSC-282 about?", "show me <ID>", "any updates on <ID>"). Those are `get_issue` calls, not start-work.

## Inputs

- **Ticket reference** (required). Either:
  - Linear ID like `EXSC-282`, `COM-14`, `EXP-377` (case-insensitive, normalize to upper)
  - Linear URL like `https://linear.app/lifi-linear/issue/EXSC-282/some-slug`
  - If missing, ask the user before proceeding.

## Team → repo mapping

Linear team prefix maps to the repo where work happens. Keep this list close to the user's actual workflow — extend by adding rows:

| Team prefix | GitHub repo | Default branch | Local clone (default search) |
|---|---|---|---|
| `EXSC` | `lifinance/contracts` | `main` | `~/Documents/GitHub/contracts` |
| `COM` | `lifinance/Yggdrasil` | `main` | `~/Documents/GitHub/Yggdrasil` |
| `EXP` | `lifinance/lifi-backend` | `main` | `~/Documents/GitHub/lifi-backend` |
| `DO` | `lifinance/devops` | `main` | `~/Documents/GitHub/devops` |

If the team prefix isn't in the table, ask the user which repo before proceeding. Don't guess.

**Finding the local clone** — try in order, stop at first hit:
1. The default path above.
2. `~/Projects/<repo-name>`, `~/Code/<repo-name>`, `~/dev/<repo-name>`, `~/src/<repo-name>`.
3. `find ~/Documents ~/Projects ~/Code ~/dev ~/src -maxdepth 4 -type d -name "<repo-name>"` (case-sensitive).
4. If still nothing: ask user for the path. Offer to `git clone` into the default location if they want.

## Workflow

### 1. Parse the ticket reference

- URL form: extract the `EXSC-282`-style ID from the path segment after `/issue/`.
- Bare ID form: uppercase the prefix, keep the number. Validate against `^[A-Z]+-\d+$`.

### 2. Fetch the issue from Linear

Use Linear MCP `get_issue` with the parsed ID. Pull these fields:
- `id`, `identifier`, `title`, `state.name`, `assignee`, `team.key`, `url`
- `attachments` / `gitBranches` (if exposed) — to detect existing linked branches

If the issue can't be found, surface the error verbatim and stop. Don't invent.

### 3. Check for "already started" state

Skip-the-work conditions, in priority order:

- **Status is already In Progress AND a branch is linked** → don't create a new branch. Output the existing branch name and the linked PR (if any), then stop. Tell the user: "Looks like this is already in flight — branch `<name>` exists. Want me to switch to it locally?" If yes, run `git fetch origin && git checkout <branch>` in the repo.
- **Assigned to someone else** → don't silently steal. Ask: "EXSC-282 is currently assigned to <name>. Take it over, or just create a branch without reassigning?" Default to the latter.
- **Status is Done / Cancelled** → ask for confirmation before reopening. "EXSC-282 is in <state>. Are you sure you want to start it?"

If none of these apply, continue.

### 4. Compute the branch name

Format: `feature/<lowercase-id>-<slugified-title>` — this matches the workspace-configured Linear branch format (`feature/identifier-title`) so the integration auto-links on first push.

Slugification rules (apply in order):
1. Lowercase the title.
2. Replace any run of non-alphanumeric characters with a single `-`.
3. Trim leading/trailing `-`.
4. Truncate to 60 chars total title length (don't break a word — cut at the last `-` within the limit).
5. Drop the trailing `-` if truncation created one.

Examples:
- `EXSC-282` + "Earn Monetization v2: Custom Vault Wrapper Design & Estimate" → `feature/exsc-282-earn-monetization-v2-custom-vault-wrapper-design`
- `COM-14` + "Fix flaky test in route resolver" → `feature/com-14-fix-flaky-test-in-route-resolver`

Show the computed name to the user before checkout — they may want to override (e.g. `fix/`, `chore/`, scoped prefix). Accept any valid git ref name; if it doesn't contain the ID, warn that Linear won't auto-link.

### 5. Create the branch locally

In the resolved repo path:

```bash
# verify clean state — don't clobber uncommitted work
cd <repo-path>
git status --porcelain
```

If `git status --porcelain` returns anything, **stop**. Show the user the dirty state and ask what to do:
- "Stash and proceed" → `git stash push -m "auto-stash before <ID>"`, then continue.
- "Commit on current branch first" → exit and let them handle it.
- "Proceed anyway" (rare) → continue but warn the branch will inherit the working changes.

Once clean:

```bash
git fetch origin
git checkout -b <branch> origin/<default-branch>
```

Use `origin/main` for all repos in the mapping above. If a repo uses a different default (e.g. `master`, `develop`), detect via `git symbolic-ref refs/remotes/origin/HEAD` and use that.

### 6. Move the Linear ticket to In Progress

Use Linear MCP `save_issue` with:
- `id`: the issue ID from step 2
- `state`: the team's "In Progress" state ID

To find the state ID: call `list_issue_statuses` for the team once and cache mentally for this turn. Match by `name == "In Progress"` (case-sensitive; LI.FI's convention). If no exact match, surface the available states and ask.

Skip if the ticket is already In Progress (idempotent — don't error).

### 7. Assign to the current user

Use Linear MCP `save_issue` with:
- `id`: the issue ID
- `assignee`: the current user

To resolve "current user": call Linear MCP for the authenticated user's ID (via `read_me` or equivalent in the connected MCP). Don't hardcode an email or user ID in this skill — the skill should work for any teammate who installs it.

Skip if the ticket is already assigned to the current user. If assigned to someone else, follow the rule from step 3 — only reassign if the user confirmed takeover.

### 8. Report

One-line summary:

```
Started <ID> — <title>
  branch: <branch-name>
  repo:   <local-path>
  linear: <linear-url>
```

If anything was skipped (already In Progress, already assigned, etc.), note it in a second line so the user knows what state things are in.

## Failure modes

- **Linear MCP not connected** → tell user to connect it; do not fall back to the Linear web API (no auth available).
- **Repo not found locally** → see step "Finding the local clone". Offer to clone.
- **Branch name collision** (`git checkout -b` fails because branch exists) → surface the existing branch; offer to switch to it (`git checkout <branch>`) or pick a suffix like `-2`.
- **Dirty working tree** → never `git stash` automatically; always ask.
- **Linear state transition fails** (permissions, missing state) → branch was already created, so don't roll it back. Report partial success and the specific Linear error.

## Design notes (why this skill exists)

- **The Jira "create branch" equivalent, plus more.** Linear's native "Create branch" button creates the branch on GitHub remote only and doesn't change ticket state. This skill closes both gaps: local checkout + status flip + ownership claim in one shot.
- **Ownership is claimed at start-of-work, not at PR-open.** PR-auto-assign is intentionally off in workspaces that want unassigned tickets to remain a pool. But the moment someone runs this skill, they're claiming the work — that's the right signal to assign.
- **Branch naming matches Linear's configured format** (`feature/identifier-title`) so the auto-link works on first push without manual PR-body magic words. Magic words (`Fixes EXSC-282`) are still a fine fallback for ad-hoc branches that don't follow the format.
- **No GitHub branch creation via the Linear button.** That path creates the branch on GitHub's HEAD of the default branch, which forces a `git fetch && git checkout` dance locally. Doing it locally is one step.
- **Idempotent on re-run.** Running the skill twice on the same ticket should not error, double-assign, or duplicate branches — it should detect existing state and skip cleanly.

## Variations the user may request

- "Use branch prefix `fix/` instead of `feature/`" → honor for this run; don't persist.
- "Don't assign to me, just create the branch" → skip step 7.
- "Don't change status" → skip step 6 (useful when starting exploratory work that shouldn't tell the team you've committed).
- "Take it over from <name>" → bypass the step-3 reassignment guard; proceed to assign to current user.
- "Use worktree instead of branch" → run `git worktree add ../<repo>-wt-<short-id> -b <branch> origin/<default>` instead of `checkout -b`. Useful when the user has uncommitted work on the current branch they don't want to stash.
