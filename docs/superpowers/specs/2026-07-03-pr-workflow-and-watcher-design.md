# PR workflow change + autonomous PR watcher — design

Date: 2026-07-03
Owner: Daniel Blaecker

## Problem

1. Confirming before every `git commit` / `gh pr create` after a change has
   already been discussed and agreed is friction Daniel wants removed —
   globally, not just in this repo.
2. The local CodeRabbit gate (`/pr-ready`, enforced by
   `.claude/scripts/pr-ready-gate.ts` as a `PreToolUse` hook in this repo)
   frequently hits CodeRabbit CLI rate limits, wasting time for the whole SC
   team.
3. There is no standing mechanism that watches Daniel's open PRs across the
   `lifinance` org for new CI failures or review comments and reacts —
   today that requires Daniel to notice, open the PR, and ask Claude to fix
   it turn by turn.

## Scope

Three independent changes:

### A. Global directive — commit/PR without confirmation

Add to `~/.claude/CLAUDE.md`: once a change has been discussed and agreed
with Daniel in-session, commit and open the PR without a separate
"want me to commit / open a PR?" confirmation step. This does not relax any
other safety behavior (destructive ops, force-push, etc. still confirm per
the existing Git Safety Protocol) — it only removes the redundant ask for
the commit/PR step itself, since discussing the change already is the
confirmation.

### B. Contracts repo — remove the mandatory local CodeRabbit gate

Remove entirely, since `/pr-ready`'s only job is the local CodeRabbit
workflow (install/auth, run `coderabbit review`, classify findings,
apply fixes, write the `PR_READY_OK` gate marker) — there's no separable
non-CodeRabbit functionality to keep:

- Delete `.agents/commands/pr-ready.md` and its symlinks
  (`.cursor/commands/pr-ready.md`, `.claude/skills/pr-ready/SKILL.md`).
- Delete `.claude/scripts/pr-ready-gate.ts`.
- Remove the `PreToolUse` hook entry referencing `pr-ready-gate.ts` from
  `.claude/settings.json`.
- Edit `.agents/rules/099-finish.md`: drop the mandatory-`/pr-ready` bullet;
  note that review feedback now arrives via the PR watcher (design C) and
  GitHub-side CodeRabbit CI (which still runs in CI as before — only the
  *local* pre-flight goes away).
- Edit `~/.claude/CLAUDE.md`'s "Pre-PR workflow" section: remove the
  contracts-specific gate/bypass documentation (`PR_READY_OK`,
  `pr-ready-gate.py`/`.ts`), replace with a pointer to directive A and the
  watcher.
- `self-review-pass` is unrelated (a semantic/mechanical PR-context sweep,
  not CodeRabbit) and is untouched.
- `pr-ready-gate-worktree-cwd-misfire` memory becomes stale once the gate
  is deleted — remove it in the same pass.

This is a repo-wide policy change (the hook fires for anyone's agent
session in this repo, not just Daniel's).

### C. New scheduled watcher — `watch-my-open-prs`

A Claude scheduled task (`create_scheduled_task`, cron), not a GitHub
Action — runs inside the local app so it can act autonomously with
Daniel's tool access (Bash/git/gh, Slack MCP, `spawn_task` chips), rather
than just posting a notification.

**Schedule**: cron, every 30 minutes, restricted to 08:00–20:00 in the
app's OS-local time (`*/30 8-19 * * *`, i.e. last run starts 19:30 — flagged
as a close-enough approximation of the 08:00–20:00 window rather than exact
20:00 cutoff, since a single 5-field cron can't express "every 30 min
inside an exact window" without the +30min tail). Daniel to confirm the
machine's OS timezone is actually Asia/Bangkok before relying on this.

**Scope**: every open PR authored by `0xDEnYO` across the `lifinance` org.

**Each run (fully self-contained prompt, no memory of prior runs)**:

1. `gh search prs --author=0xDEnYO --owner=lifinance --state=open --json ...`
   to enumerate PRs.
2. Per PR, pull CI rollup, review comments/threads, and review decision via
   `gh pr view` / `gh api`.
3. Load dedup state from
   `~/.claude/scheduled-tasks/watch-my-open-prs/state/<owner>-<repo>-<number>.json`
   (last-seen comment IDs, last-checked commit SHA). Skip anything already
   recorded; only act on what's new since the last run.
4. Classify each new finding:
   - **Narrow auto-fix allowlist** (mechanical only):
     - formatter/lint `--fix` output
     - a CI job failing purely on a lint/format check
     - single-line CodeRabbit nits quotable verbatim (typo, unused import,
       missing `await`, wrong SPDX/license header)
   - **Everything else** (logic, tests, config/dependency changes,
     ambiguous comments, anything architectural/security-relevant) escalates
     — no auto-fix attempt.
5. For auto-fixable findings: create a disposable clone/worktree for that
   repo+branch, apply the fix, commit, push to the PR's existing feature
   branch. Never touch `main`/protected branches directly, never
   force-push, never merge, never `--no-verify`. Then `spawn_task` a chip:
   "Pushed a lint fix to `<repo>#<pr>` — <one-line summary>."
6. For escalations: `spawn_task` a chip with a self-contained prompt
   (repo, PR #, branch, the specific finding, and enough context that
   clicking it can act immediately without re-deriving context).
   Fallback if `spawn_task` is unavailable from a scheduled-task context
   (untested — normally used from interactive sessions): send a Slack DM
   instead for that run, and record the fallback in state so it's visible
   later.
7. Update the dedup state file with whatever was just seen/acted on.

**Explicit non-goals for v1**: no auto-merge, no auto-resolving test
failures, no repo-specific auto-fix logic beyond the narrow allowlist
above (even in repos with their own lint/format tooling, the allowlist is
the ceiling), no cross-repo learning/state beyond the per-PR JSON files.

## Risks / open items carried into implementation

- `spawn_task` chip creation from a scheduled-task run is unverified —
  first real run will confirm; Slack DM is the fallback path.
- OS-local cron timezone needs a one-time check by Daniel.
- The narrow auto-fix allowlist is intentionally conservative; revisit
  after a couple weeks of real runs (mirrors the same "trial period"
  language the old `/pr-ready` auto-apply allowlist used).
