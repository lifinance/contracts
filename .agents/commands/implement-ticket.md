---
name: implement-ticket
description: "Takes one EXSC ticket from start to an open, clean PR in the current session without pausing: starts the ticket, plans, implements and tests, commits, has a fresh-context subagent review the diff, then opens the PR and drives it to clean. Supervised and in-session, unlike the unattended AI Factory (`factory-*` skills) that runs tickets outside the session. Use for \"implement EXSC-<N>\", \"work on this ticket end to end\", or \"take EXSC-<N> to a PR\"."
usage: /implement-ticket <EXSC-ID | Linear URL>
---

# Implement Ticket

Runs ticket → branch → implementation → review → clean PR without asking the user anything.
Sub-skills run in their unattended mode.

## Stops

The run stops early in two cases only, and the report names which and at which step:

- **user decision**: the ticket cannot be implemented without a value, trade-off or scope
  choice it does not answer, the ticket is assigned to someone else, or a sub-skill raises a
  prompt.
- **blocker**: a tool, MCP, CI, test or infra failure; a dirty worktree at start (never stash,
  discard or carry changes over); the full suite still failing after 3 fix attempts on the same
  failure (report the failing test and the last error).

## Steps

### 1. Start the ticket

1. Fetch the ticket; a non-EXSC ID or one Linear can't find is a blocker. Assigned to someone
   other than `me` → user decision.
2. `git status --porcelain` non-empty → blocker.
3. Look for a branch containing `exsc-<N>-` locally or on origin.
   - Found and the ticket is In Progress: check it out (`git switch <branch>`, then
     `git pull --ff-only` when it has an upstream) and go to step 2 on its existing commits.
     Checked out in another worktree → blocker naming that path.
   - Found and not In Progress: check it out as above, then run `/start-linear-ticket <ID>`.
   - Not found: run `/start-linear-ticket <ID>`.

### 2. Plan

Read the ticket, its comments and any existing commits on the branch
(`git log origin/main..HEAD`). Plan internally; no plan is shown for approval. Load the rules
for every file the plan touches, per `000-global-standards` "Rule activation".

### 3. Implement and test

- Implement the plan. Iterate with scoped tests (`bun test:scoped`, `forge test --match-path`),
  then run the full suite that covers the diff, using the commands in `create-pr` step 4
  "Test". A docs- or skill-only diff needs no tests.
- A failing full suite gets at most 3 fix attempts on the same failure, then blocker.
- Commit this work's files on the branch (no `git add -A`; never `--no-verify`). Step 4 reviews
  committed work only: untracked files are invisible to `git diff`.

### 4. Fresh-context review

Spawn a new `general-purpose` subagent with the Agent tool, never a fork: a fork inherits the
implementer's reasoning. Its prompt contains only the ticket (title, body, URL) and the
instruction to:

- run `/code-review medium origin/main...HEAD`; if it cannot invoke the skill, review
  `git diff origin/main...HEAD` for correctness bugs itself and say so;
- return each finding with file:line, the defect and a concrete failure scenario.

For each finding, check the claim against the code before acting:

- **Real** → fix it.
- **Wrong or out of scope** → reject it with a reason tied to code (file:line) or the ticket's
  scope.

Commit the fixes, then run a second round with a new subagent. At most 2 rounds; findings still
open after round 2 go in the report and in the PR body's "Why I implemented it this way", and
the run continues.

### 5. Open and drive the PR

1. Run `/create-pr` as a calling skill: pass the Linear ID, a title, and a "Why" that includes
   any open review findings. All work is already committed, so pass no files to stage. Its own
   test step re-runs the tests; that is expected. It returns the PR URL.
2. Run `/drive-pr <N>` on that PR.

### 6. Report

```text
EXSC-<N> — <title>
PR:        <url> — <drive-pr status line>
Fixed:     <finding> (<file:line>) …  | none
Rejected:  <finding> — <reason> …     | none
Open:      <finding after round 2> …  | none
Stopped:   step <n>, user decision | blocker: <why>   (omit when the run finished)
```
