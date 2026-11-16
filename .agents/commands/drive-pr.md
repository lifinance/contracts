---
name: drive-pr
description: Drives an open lifinance/contracts PR to clean without pausing — fixes failing CI, answers and resolves every CodeRabbit thread, triages Aikido, marks the draft ready and repeats on the checks that only run on ready PRs. Use for "drive the PR", "get the PR clean", "fix CI and CodeRabbit", after pushing reviewer fixes, or as the last step of create-pr.
usage: /drive-pr [<PR number | PR URL>] — defaults to the current branch's PR
---

# Drive PR

Takes an open PR to **clean**: CI green apart from the exempt checks, every CodeRabbit thread
answered and resolved, Aikido triaged, PR ready for review. This is the end of stage 3 in
`503-sc-feature-pr-lifecycle`.

Never pause for the user except on a stop condition (below) or a decision only the user can
make. Never post to Slack.

## Preflight

PR number or URL; without one, use the current branch's PR, and ask if there is none.

- **Fork or someone else's PR** (`isCrossRepository`, or author ≠ `gh api user`): stop before
  the first push unless the user said to drive it.
- **Local branch**: on the PR's head branch with a clean tree (`gh pr checkout`; dirty tree →
  ask), then `git pull --ff-only`.
- **Rollout PR** (every changed file under `deployments/`): never marked ready. Run Phase A only
  and report it was left as a draft.

## Pushing rules

- Signed commits (`git commit -S`); a signing failure stops the skill.
- Never `--no-verify`, never force-push. A failing pre-commit hook is fixed like a failing check.
- Before each push, run the tests and linters relevant to the fix (`099-finish`).
- Never add `audit/auditLog.json` entries, never set or remove `AuditRequired`,
  `AuditNotRequired` or `AuditCompleted`, never dismiss Olympix alerts.

## Phases

`version-control`, `verify-signed-commits` and `Aikido Security: check code` report `SKIPPED`
on drafts, and a SHA can carry a draft's `skipped` run before the ready one.

- **Phase A (draft)**: rounds until no blocking check, CodeRabbit settled and no open CodeRabbit
  thread, then `gh pr ready`. Already ready → Phase B.
- **Phase B (ready)**: rounds on the new check runs. **Clean is judged here only**; a `skipped`
  run never counts as a pass for those three checks.

## One round

### 1. Wait

Wait in the background (never a foreground poll), bounded at 30 min per stage; continue when it
reports. In a worktree session Claude Code refuses inline multi-line Bash, so save the script to
the scratchpad and run it as a file.

1. **Head**: the PR's `headRefOid` equals the pushed SHA. If someone else's commit lands,
   `git pull --ff-only` and restart the round on it. Never report clean for a stale SHA.
2. **CI**: from `gh pr checks --json name,state,event,link`, leaving out the ignored checks
   (step 2): at least one check, none in progress, and the set unchanged across two polls, so
   late workflows are caught.
3. **Bots and ready-only checks**, read per SHA from
   `repos/lifinance/contracts/commits/<SHA>/check-runs?check_name=<name>` (URL-encode the
   name). `gh pr checks` can finish before these register.
   - Always `CodeRabbit`: settled when `completed`. `success` / `Finished` = reviewed;
     `neutral` / `Review rate limited` = **not** reviewed, though `gh pr checks` shows it
     passing.
   - Phase B: `Aikido Security: check code`, plus `version-control` and `verify-signed-commits`
     when the base is `main` (they don't run otherwise): settled when `completed` and not
     `skipped`. A clean Aikido scan posts no comment, so the check run is its only signal.
   - First Phase B round, when the PR changes `src/**/*.sol`: `check-security-alerts`
     (`securityAlertsReview.yml` runs on `ready_for_review` only, never on later pushes).

Anything still unsettled at the bound is a failure not caused by the diff (step 3).

### 2. Classify every check

- **Pass**: `SUCCESS` / `SKIPPED` / `NEUTRAL`. **In progress**: `QUEUED` / `IN_PROGRESS` /
  `PENDING` / `WAITING` / `REQUESTED`. **Anything else blocks.**
- **Ignored**: every `audit-*` check (red until the audit is filed, stage 9), and checks whose
  `event` is `pull_request_review` (they run once a reviewer acts).
- **Human gate**: `protect-critical-code`. Report its state; never try to fix it.
- **Not exempt**: `version-control` shares a workflow with the audit checks, but a missing
  contract version bump is a real failure.

### 3. Fix blocking checks

- Actions check: `gh run view <run-id> --log-failed`. Other check run: its `output` from the
  check-runs API.
- **Not caused by the diff** (infra error, rate limit, missing secret, `CANCELLED`, superseded by
  a later push; `*-required` aggregators fail with it): `gh run rerun <run-id> --failed` once.
  Same failure again → stop, reported as not caused by the PR.

### 4. CodeRabbit

**Rate limited**: comment `@coderabbitai review` once per head SHA (skip if you already posted it
after that commit), then wait as in step 1 until the run is no longer rate limited. Still rate
limited once all else is clean → carry on and report "CodeRabbit not reviewed (rate limited)".
Never count it as reviewed.

**Threads**: the `main protection` ruleset requires every review thread resolved, outdated ones
too. Read all of them via GraphQL `reviewThreads` (paginated). For each unresolved thread started
by `coderabbitai`:

1. Check the claim against the current code; don't take it on trust.
2. Correct → fix it and reply `Addressed in <sha>`. Wrong or not worth it → reply with the
   reasoning. Outdated and no longer true → `No longer applies: <why>`. Needs a design or scope
   decision → stop condition.
3. Resolve it (`addPullRequestReviewThreadReply`, `resolveReviewThread`).

Reply to and resolve fixed threads after the step 6 push, so `<sha>` is on the PR. Threads by
people stay open: list them in the report.

### 5. Aikido (Phase B)

Once its run has settled, run `/aikido-address-findings pr unattended`. It ignores catalog false
positives and commits fixes. Resolve ignored findings' threads now and fixed ones only after the
step 6 push. A **Manual review** finding or a failed scan is a stop condition.

### 6. Push and repeat

Push the round's commits together, reply to and resolve the threads they fix, then start the next
round on the new SHA.

## After `gh pr ready`

If `securityAlertsReview` turns the PR back to draft, report the Olympix alerts from its comment
(`### 🤖 GitHub Action: Security Alerts Review 🔍`), print the PR link and stop. Never mark it
ready again.

## Stop conditions

Report what failed, what was tried and the PR link when:

- the same failure comes back after a fix attempt,
- a finding needs a user decision,
- 5 rounds have run (Phase A and B together).

## Final report

```text
<PR URL> — clean | stopped: <reason> | left as draft (deployments-only)
CI:          N passing, ignored: audit-* (expected before audit), protect-critical-code: <state>
CodeRabbit:  reviewed — T threads (F fixed, R replied) | not reviewed (rate limited)
Aikido:      I ignored, F fixed, M manual review | clean scan
Open threads by people: <url list or none>
Rounds:      <n>
```

When clean, offer `/post-pr-for-review`.
