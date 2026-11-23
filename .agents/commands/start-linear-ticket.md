---
name: start-linear-ticket
description: 'Starts work on an EXSC ticket in lifinance/contracts from a ticket ID/URL or a free-text description: creates or repairs the ticket via /create-linear-ticket so it is assigned, estimated and in a cycle, puts work on a branch carrying the ticket ID, and moves the ticket to In Progress. Default mode creates a new branch from origin/main in the current worktree; --existing-branch renames the current branch instead. Use for "start EXSC-123", "start linear ticket", "begin work on <ID>", or a description with intent to start work. Skip for read-only questions about a ticket.'
---

# Start Linear Ticket

Guarantees: the ticket is assigned, estimated and in a cycle, it is In Progress, and work happens on a branch whose name carries `exsc-<N>` — except in existing-branch mode on a pushed branch or one with an open PR, which links through `Fixes EXSC-<N>` instead.

## Inputs

- **Ticket or description** (required): an EXSC ID or Linear URL, matched case-insensitively (a URL's ID is the segment after `/issue/`); otherwise a free-text description. Refuse any other team prefix in one line: this skill handles EXSC tickets in lifinance/contracts only.
- **`--existing-branch`** (optional): rename the current branch instead of creating one. Only this explicit flag selects it, because a rename is destructive.
- **Unattended** (nobody to answer): stop with a one-line reason on an open duplicate, a missing next cycle, several matches after a failed save (list the candidates), a ticket assigned to someone else, a Done/Cancelled ticket, a dirty tree in default mode, or an unresolvable In Progress status. Ask nothing else; estimate and cycle take `/create-linear-ticket`'s proposals.

## 1. Resolve the ticket

- **Description**: first run the branch checks that need no ticket (default mode's dirty tree; existing-branch mode's `main`/detached HEAD), so a run that will stop does so before a ticket exists. Then run `/create-linear-ticket`. In existing-branch mode give it the branch's work against `origin/main` as context, including uncommitted changes and the contents of untracked files. If the user picks a duplicate there, end that run before its repair (repair writes to Linear, and the step 2 guards must run first) and continue with that ID as an existing ticket.
- **ID**: fetch the issue; if Linear can't find it, report the error verbatim and stop.

## 2. Guards (read-only)

1. **Branch exists**: a branch containing `exsc-<N>-` exists locally or on origin, whatever the ticket's status. Never create a second one. Linear's `gitBranchName` is not evidence: it is always set.
   - Current branch → keep it.
   - Checked out in another worktree → report that path and stop.
   - Otherwise offer to switch to it, up to date with its remote (unattended: report it and stop). Declined → stop.

   Then skip step 3. If the ticket is already In Progress, report and stop; otherwise continue.
2. **Assigned to someone else**: ask before reassigning. Declined → keep the assignee and continue.
3. **Done or Cancelled**: ask before reopening. Declined → stop.

## 3. Branch

**Name**: `<type>/exsc-<N>-<slug>`. `<type>` is `fix` when the ticket has the `Bug` label, else `feat`; the user may override it. `<slug>`: the lowercase title, runs of non-alphanumerics as `-`, trimmed, at most 60 chars cut at the last `-` (a hard cut when there is none); empty → ask (unattended: `work`). If the name exists locally or on origin, stop and report it.

**Default mode**: create the branch from freshly fetched `origin/main` in the current worktree — no new worktree, no other clone, local `main` untouched. Use `--no-track`: by default the branch would track `origin/main`, and a push could land there.

A dirty tree: offer to carry the changes onto the new branch (git keeps uncommitted changes that don't conflict with `origin/main`; if it refuses, report and stop) or to stop. Never stash or discard.

**Existing-branch mode** ignores the working tree:

- Refuse on `main`/`master` or a detached HEAD.
- The branch has an upstream or an open PR → don't rename it (that would strand the PR); continue to step 4 and report that the PR body needs `Fixes EXSC-<N>`.
- Otherwise `git branch -m <name>` — never `-M`, which overwrites an existing branch.

## 4. Linear writes

Only after the branch exists or the rename succeeded:

1. An existing ticket goes through `/create-linear-ticket` repair mode, passing the step 2 reassignment answer so it doesn't ask again. Skip when step 1 created it.
2. Set the status to In Progress and the assignee to `"me"`, skipping each when already so, and the assignee when a reassignment was declined. If In Progress doesn't resolve for the team, list its statuses and ask.

A Linear failure here is partial success: keep the branch and report which write failed, with the error.

## 5. Report

```text
Started EXSC-<N> — <title>
  branch:   <branch>  (created from origin/main | renamed from <old>)
  linear:   <url>
  ticket:   assignee <name>, estimate <n>, cycle <name>, In Progress
```

Add one line for anything skipped or left as is.
