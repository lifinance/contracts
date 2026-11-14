---
name: start-linear-ticket
description: 'Starts work on an EXSC ticket in lifinance/contracts from a ticket ID/URL or a free-text description: creates or repairs the ticket via /create-linear-ticket so it is assigned, estimated and in a cycle, puts work on a branch carrying the ticket ID, and moves the ticket to In Progress. Default mode creates a new branch from origin/main in the current worktree; --existing-branch renames the current branch instead. Use for "start EXSC-123", "start linear ticket", "begin work on <ID>", or a description with intent to start work. Skip for read-only questions about a ticket.'
---

# Start Linear Ticket

Guarantees: the ticket is assigned, estimated and in a cycle, it is In Progress, and work happens on a branch whose name carries `exsc-<N>` — except in existing-branch mode on a pushed branch or one with an open PR, which links through `Fixes EXSC-<N>` instead.

## Inputs

- **Ticket or description** (required):
  - EXSC ID or Linear URL, case-insensitive (`exsc-12` works). A URL's ID is the path segment after `/issue/`. Normalize to `EXSC-<N>`.
  - Any other team prefix: refuse with one line — this skill handles EXSC tickets in lifinance/contracts only.
  - Anything else is a free-text description of the work.
- **`--existing-branch`** (optional): rename the current branch instead of creating one. Selected only by this explicit flag, never inferred from the current branch.
- **Unattended** (nobody to answer): these stop the run with a one-line reason — an open duplicate, a missing next cycle, a ticket assigned to someone else, a Done/Cancelled ticket, a dirty tree in default mode. Ask nothing else; estimate and cycle take `/create-linear-ticket`'s proposals.

## 1. Resolve the ticket

- **Description**: first run the branch-mode checks that don't need the ticket — default mode's dirty-tree check (step 3, item 1); existing-branch mode's `main`/detached HEAD and upstream/open-PR guards (step 3) — so a run that will stop does so before a ticket exists. Then run `/create-linear-ticket` with the description. In existing-branch mode also give it `git diff origin/main...HEAD` as context. If the user picks an existing duplicate there, continue with that ID as an existing ticket (repair in step 4, guards in step 2).
- **ID**: `get_issue` with `fields: ["title", "status", "statusType", "assignee", "labels", "url"]`. Not found → report the error verbatim and stop.

## 2. Guards (read-only)

Check in order:

1. **Branch exists**: a branch containing `exsc-<N>-` exists locally (`git branch --list '*exsc-<N>-*'`) or on origin (`git ls-remote --heads origin '*exsc-<N>-*'`), whatever the ticket's status. Linear's `gitBranchName` is not evidence: it is always set. Never create a second branch for the ticket.
   - That branch is current → keep it.
   - It is checked out in another worktree (`git worktree list --porcelain`) → report that worktree's path and stop.
   - Otherwise offer to switch (unattended: report it and stop): `git switch <branch>` then `git merge --ff-only '@{u}'` if it has an upstream; else `git switch --track origin/<branch>`. Declined → stop.

   Then skip step 3: status already In Progress → report and stop; otherwise continue with the remaining guards and step 4.
2. **Assigned to someone else**: ask before reassigning. Declined → continue without changing the assignee.
3. **Done or Cancelled**: ask before reopening. Declined → stop.

## 3. Branch

**Name**: `<type>/exsc-<N>-<slug>`.

- `<type>`: `fix` when the ticket has the `Bug` label (the Bug Ticket template sets it), else `feat`. The user may override it.
- `<slug>`: lowercase title; runs of non-alphanumerics → `-`; trim `-` at both ends; at most 60 chars, cut at the last `-` within the limit (hard cut at 60 when none falls within it). An empty slug → ask for one (unattended: use `work`).

If the name exists locally or on origin (`git branch --list <name>`, `git ls-remote --heads origin <name>`), stop and report it.

**Default mode** — in the current worktree; no new worktree, no other clone, local `main` untouched:

1. `git status --porcelain`. If dirty, offer:
   - (a) carry the changes onto the new branch — the switch below keeps uncommitted changes that don't conflict with `origin/main`; if git refuses, report its output and stop;
   - (b) stop.

   Never stash, never discard.
2. `git fetch origin main`
3. `git switch --no-track -c <name> origin/main` (`--no-track` so the branch never pushes to `main`).

**Existing-branch mode** — ignores working-tree state. Guards, in order:

- On `main`/`master` or detached HEAD → refuse.
- Branch has an upstream (`git rev-parse --abbrev-ref '@{u}'` succeeds) or an open PR (`gh pr view --json url,state`, `state` is `OPEN`) → do not rename; continue to step 4 and report that the PR body needs `Fixes EXSC-<N>` to link it.

Then `git branch -m <name>` (never `-M`).

## 4. Linear writes

Run only after the branch exists or the rename succeeded:

1. Existing ticket: `/create-linear-ticket` repair mode with the ID and the step 2 reassignment answer (so it doesn't ask again), so the ticket ends assigned, estimated and in a cycle. Skip when step 1 just created or repaired it.
2. `save_issue` with `id`, `state: "In Progress"` (skip if already there) and `assignee: "me"` (skip if already the current user; omit if the user declined a reassignment in step 2). If the state name doesn't resolve, `list_issue_statuses` for the team and ask which to use.

A Linear failure here is partial success: keep the branch, report which write failed with its error.

## 5. Report

```text
Started EXSC-<N> — <title>
  branch:   <branch>  (created from origin/main | renamed from <old>)
  linear:   <url>
  ticket:   assignee <name>, estimate <n>, cycle <name>, In Progress
```

Add one line for anything skipped or left as is (already In Progress, reassignment declined, PR body needs `Fixes EXSC-<N>`).
