---
name: implement-ticket
description: "Takes one EXSC ticket from start to an open, clean PR in the current session without pausing: starts the ticket, plans, implements and tests, commits, has a fresh-context subagent review the diff, then opens the PR and drives it to clean. Supervised and in-session, unlike the unattended AI Factory (`factory-*` skills) that runs tickets outside the session. Use for \"implement EXSC-<N>\", \"work on this ticket end to end\", or \"take EXSC-<N> to a PR\"."
usage: /implement-ticket <EXSC-ID | Linear URL>
---

# Implement Ticket

Ticket → branch → implementation → review → clean PR, without asking the user anything. Tell
every sub-skill the run is unattended (nobody to answer).

## Stops

The run stops early only in these two cases; the report names which, at which step, and why:

- **user decision**: the ticket needs a value, trade-off or scope choice it doesn't answer; it
  or its open PR belongs to someone else; or a sub-skill raises a prompt.
- **blocker**: a tool, MCP, CI, test or infra failure; a dirty worktree at start (never stash or
  carry changes over); the full suite still failing after 3 fix attempts on the same failure.

## Steps

1. **Start.** If the ticket already has a branch (an `exsc-<N>-` branch, or the head of an open
   PR that `Fixes`/`Ref`s it) and is In Progress or later, check it out and continue from step 2
   on its commits. Otherwise run `/start-linear-ticket <ID>`, after checking out the branch if
   one exists. An ambiguous match is a blocker.

2. **Plan** from the ticket, its comments and any existing commits. Plan internally; nothing is
   shown for approval. Load the rules for the files you will touch, per `000-global-standards`.

3. **Implement and test**: scoped tests while iterating, then what `create-pr` step 4 "Test"
   prescribes. Commit the work (signed) before step 4, which reviews only committed work.

4. **Fresh-context review.** Spawn a new `general-purpose` subagent, never a fork (a fork
   inherits your reasoning). Give it only the ticket and ask it to run
   `/code-review medium origin/main...HEAD`, wait for the result (it can arrive later as a
   background notification), and fall back to reviewing `git diff origin/main...HEAD` itself,
   saying so, if the skill can't run or never reports. Check each finding against the code:
   - **Fix** it when it is real and worth the change.
   - **Reject** it with a reason tied to code (file:line) or the ticket: wrong, out of scope,
     or valid but not worth it (the fix adds more complexity or risk than it removes).

   Re-test and commit the fixes. Run a second round only if the first produced fixes; there is
   no third. Findings still open after round 2 go in the report and the PR's "Why".

5. **PR.** Run `/create-pr` as a calling skill: it opens the PR and returns the URL but does not
   drive it. Pass a "Why" for a new PR; for an existing one, pass its current "Why" plus any
   open findings, or none. Then run `/drive-pr <N>`. Its `/post-pr-for-review` offer goes in
   the report, not a stop.

6. **Report.**

   ```text
   EXSC-<N> — <title>
   PR:        <url> — <drive-pr status line>
   Fixed:     <finding> (<file:line>) …     | none
   Rejected:  <finding> — <reason> …        | none
   Open:      <finding after round 2> …     | none
   Stopped:   step <n>, <user decision | blocker>: <why>   (omit when finished)
   ```
