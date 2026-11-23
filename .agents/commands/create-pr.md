---
name: create-pr
description: "Commits the current work, runs build and tests, and opens a PR from .github/pull_request_template.md linked to its EXSC Linear ticket, then hands off to drive-pr. Use for \"create PR\", \"open PR\", \"push and PR\", or from a skill that needs a PR opened."
---

# Create PR

Takes the work on the current branch to an open PR linked to its EXSC ticket. Runs without
pausing; the only question it may ask is the missing-ticket one in step 2.

## Inputs

- **Linear ID or URL**: overrides the `exsc-<N>` in the branch name.
- **Base branch**: `main` unless the user names another, e.g. for a stacked PR.
- **Called from another skill**: the caller passes the files to stage, the title/commit
  message, the "Why", and a Linear ID (with an optional partial-work flag) or an explicit
  opt-out; derive anything it omits from the diff. Ask nothing and stop after step 6 with the
  PR URL: the caller continues its own flow and decides when the PR leaves draft.

## Steps

1. **Assess state.** Stop if there is nothing to PR (clean tree, no commits ahead of the base)
   or HEAD is detached. On `main`/`master`, branch first, since protected branches never take
   commits: `<type>/exsc-<N>-<slug>` when the ID is known, else `<type>/<slug>` for step 2 to
   rename. If the branch already has an open PR, update it instead: run steps 2–5, push, and
   patch title and body per `.agents/context.md` "Creating and editing PRs via gh", keeping its
   "Why" unless the caller supplies one.

2. **Resolve the ticket.** Linear links a PR through the `exsc-<N>` in the branch name or a
   `Fixes`/`Ref` line in the body. Take the supplied ID (or one the user named this session),
   else the branch's `exsc-<N>` in any case, and `get_issue` it
   for its `url`. A missing, unknown or non-EXSC ID counts as none; keep a non-EXSC ticket as an
   extra `Ref` line. With none, ask the user to provide an ID, create one
   (`/start-linear-ticket --existing-branch`, titled from the diff), or opt out
   (`<!-- No Linear task -->`, and suggest the `trivial` label for a typo, doc-only, dep-bump or
   single-line PR so the ticket-linkage metric counts it). Unattended runs, and called runs
   with neither an ID nor an opt-out, create one without asking.

3. **Commit.** Stage only this work's files, or exactly the caller's list. Worktrees often hold
   unrelated or secret files, so no `git add -A`; report anything left out.

4. **Test.** Pre-commit lints, formats and typechecks but neither builds nor tests. Run what
   covers the diff: `bun run test` (or `forge test --match-path`) for Solidity, `bun test:ts`
   for TS, nothing for a docs- or skill-only diff. A failure stops the run before the push.

5. **Title and body.** Title ≤70 chars in `git log` style. Body:
   `.github/pull_request_template.md` verbatim, since the review process keys on its headings;
   stop if it is missing.
   - Linear line: `Fixes [<ID>](<url>)`, or `Ref` when the caller marks partial work, so
     merging does not close the ticket.
   - "Why": one paragraph on one line; GitHub renders single newlines in PR bodies as breaks.
   - Author checklist: each tick is a claim, so tick only what you checked. Self-review means
     walking the full diff against the base. Leave the reviewer checklist unchecked.

6. **Open.** `git push -u origin <branch>`; a rejected push stops the run (never force-push).
   Write the body to the session scratchpad, run
   `gh pr create --draft --base <base> --head <branch> --title … --body-file …` and print the
   URL. Open as draft: `createPRsAsDraft.yml` converts a PR only after its `opened` event, which
   still runs the ready-only checks, and `deploymentAddressConsistency.yml` fails a rollout PR
   whose flat log is ahead of `diamond.json`.

7. **Hand off.** On a direct user invocation, run `/drive-pr <N>`. When called from a skill,
   return the URL.
