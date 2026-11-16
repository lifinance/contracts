---
name: drive-pr
description: Drives an open lifinance/contracts PR to clean without pausing — fixes failing CI, answers and resolves every CodeRabbit thread, triages Aikido, marks the draft ready, repeats on the checks that only run on ready PRs, then gets the Zeus QA review approved. Use for "drive the PR", "get the PR clean", "fix CI and CodeRabbit", after pushing reviewer fixes, or as the last step of create-pr.
usage: /drive-pr [<PR number | PR URL>] — defaults to the current branch's PR
---

# Drive PR

Takes an open PR to **clean**: CI green apart from the exempt checks, every CodeRabbit thread
answered and resolved, Aikido triaged, PR ready for review and approved by the Zeus QA agent.

Never pause for the user except on a stop condition (below) or a decision only the user can
make. Never post to Slack.

## Preflight

PR number or URL; without one, use the current branch's PR, and ask if there is none. List
changed files with `gh api repos/lifinance/contracts/pulls/<N>/files --paginate`
(`gh pr view --json files` stops at 100).

- **Fork or someone else's PR** (`isCrossRepository`, or author ≠ `gh api user`): stop before
  the first push unless the user said to drive it.
- **Local branch**: on the PR's head branch with a clean tree (`gh pr checkout`; dirty tree →
  ask), then `git pull --ff-only`.
- **Rollout PR** (every changed file under `deployments/`): this skill never marks it ready and
  skips step 7. Run Phase A rounds only and report its actual draft or ready state.

## Pushing rules

- Signed commits (`git commit -S`); a signing failure stops the skill.
- Never `--no-verify`, never force-push. A failing pre-commit hook is fixed like a failing check.
- Before each push, run the tests and linters relevant to the fix (`099-finish`).
- Never add `audit/auditLog.json` entries, never set or remove `AuditRequired`,
  `AuditNotRequired` or `AuditCompleted`, never dismiss Olympix alerts.

## Phases

`version-control`, `verify-signed-commits` and `Aikido Security: check code` report `SKIPPED`
on drafts.

- **Phase A (draft)**: rounds until no blocking check, CodeRabbit settled and no open CodeRabbit
  thread, then `gh pr ready`. Already ready → Phase B.
- **Phase B (ready)**: rounds on the new check runs until clean apart from Zeus, then step 7.
  **Clean is judged here only**; a `skipped` run never counts as a pass for those three checks.

## One round

### 1. Wait

Wait in the background (never a foreground poll), bounded at 30 min for each of the waits below; continue when it
reports. In a worktree session Claude Code refuses inline multi-line Bash, so save the script to
the scratchpad and run it as a file.

1. **Head**: allow up to 5 min for the PR's `headRefOid` to reach the pushed SHA. A different
   SHA after that means someone else pushed: `git pull --ff-only` and restart the round on it.
   Never report clean for a stale SHA.
2. **CI**: from `gh pr checks --json name,state,event,link` (it exits 8 while checks are
   pending; read the JSON, not the exit code), leaving out the ignored checks (step 2): at least
   one check, none in progress, and the set unchanged across two polls 30 s apart, so late
   workflows are caught.
3. **Bots and ready-only checks**, read per SHA from
   `repos/lifinance/contracts/commits/<SHA>/check-runs?check_name=<name>` (URL-encode the
   name). A SHA can carry several runs of one check (a draft's `skipped` run, a rate-limited
   CodeRabbit run before a re-review): read the newest by `started_at`. No run yet means not
   started, never "doesn't apply".
   - Always `CodeRabbit`: settled when `completed`. `success` / `Finished` = reviewed;
     `neutral` / `Review rate limited` = **not** reviewed, though `gh pr checks` shows it
     passing.
   - Phase B: `Aikido Security: check code`, plus `version-control` and `verify-signed-commits`
     when the base is `main` (they don't run otherwise): settled when `completed` and not
     `skipped`.
   - Only in the round right after this skill's own `gh pr ready`, when the PR changes
     `src/**/*.sol`: `check-security-alerts` (runs on `ready_for_review` only), settled when
     `completed`.
4. Phase B: read `isDraft` at the end of the wait; true → see After `gh pr ready`.

At the bound, an unsettled bot check is reported as not settled (no rerun exists); an unsettled
Actions run is a failure not caused by the diff (step 3).

### 2. Classify every check

- **Pass**: `SUCCESS` / `SKIPPED` / `NEUTRAL`. Anything not pass, in progress or ignored blocks.
- **Ignored**: every `audit-*` check (red until the audit is filed), and checks whose
  `event` is `pull_request_review` (they run once a reviewer acts).
- **Human gate**: `protect-critical-code`. Report its state; never try to fix it.
- `version-control` is not exempt: a missing contract version bump is a real failure.

### 3. Fix blocking checks

- `link` contains `/actions/runs/<run-id>/` → Actions: `gh run view <run-id> --log-failed`.
  Otherwise the link ends in a check-run ID: read its `output` from the check-runs API.
- **Not caused by the diff** (infra error, rate limit, missing secret, `CANCELLED`, superseded by
  a later push; `*-required` aggregators fail with it): `gh run rerun <run-id> --failed` once
  (`gh run cancel` first if still running). Same failure again → stop, reported as not caused by
  the PR.

### 4. CodeRabbit

**Rate limited**: comment `@coderabbitai review` once per head SHA, with the marker
`<!-- drive-pr head <SHA> -->` on its own line; skip if a PR comment already carries that
marker. Then wait as in step 1
until the newest run is not rate limited. Still rate limited once all else is clean → carry on
and report "CodeRabbit not reviewed (rate limited)". Never count it as reviewed.

**Threads**: the `main protection` ruleset requires every review thread resolved, outdated ones
too. Read all of them via GraphQL `reviewThreads` (paginated). For each unresolved thread whose
first comment's `author.login` is `coderabbitai` (GraphQL drops `[bot]`):

1. Check the claim against the current code; don't take it on trust.
2. Correct → fix it; reply `Addressed in <sha>` and resolve only after the step 6 push, so the
   SHA is on the PR. Wrong or not worth it → reply with the reasoning and resolve. Outdated and
   no longer true → `No longer applies: <why>` and resolve. Needs a design or scope decision →
   stop condition.

Reply with `addPullRequestReviewThreadReply`, resolve with `resolveReviewThread`. Threads by
people stay open: list them in the report.

### 5. Aikido (Phase B)

Once its run has settled, run `/aikido-address-findings pr unattended`. It ignores catalog false
positives and commits fixes. Resolve ignored findings' threads now and fixed ones after the step 6
push. A **Manual review** finding or a failed scan is a stop condition: push the fixes already
committed, resolve their threads, then stop.

### 6. Push and repeat

Push the round's commits together, reply to and resolve the threads they fix, then start the next
round on the new SHA.

### 7. Zeus QA review (Phase B, once all else is clean)

Zeus (`lifi-qa-agent[bot]`, from the QA team) reviews the PR against its Linear ticket. It picks
up ready PRs on its own after a few hours; add the `Agent Review Request` label to run it now
(`qa-review-trigger.yml`). A push dismisses its approval, so it goes last.

1. If the newest `lifi-qa-agent[bot]` review is not on the head SHA, add the label and note the
   time. The trigger fires only on `labeled`, so if the label is already on the PR, remove it
   first. Wait in the background (bounded, 30 min) for a `lifi-qa-agent[bot]` review with
   `commit_id` equal to the head SHA and `submitted_at` after that time. The labels alone can
   show a stale verdict from an earlier review. If `Agent Review Request` is back on the PR
   (the trigger restores it when its dispatch fails), report it and stop. No review at the bound
   → stop with `Zeus: not reviewed`; never report clean.
2. **Approved** (`APPROVED`) → clean.
3. **Changes requested** (`CHANGES_REQUESTED`): its sticky comment (`<!-- zeus:contracts-review -->`) lists the gating
   findings, each an inline thread by `lifi-qa-agent`. Each needs a code fix or a
   finding-specific reply. Check every claim against the code as in step 4:
   - Correct → fix it, push, reply `Fixed in <sha>: <what changed>` and resolve.
   - Wrong → reply with the evidence (file and line) and resolve.
   - Correct but to be deferred to a follow-up ticket → user decision: stop condition.

   After a push, run a full round (steps 1–6) on the new SHA, then this step again. Without a
   push, re-add the label so Zeus reads the replies.

## After `gh pr ready`

If `securityAlertsReview` turns the PR back to draft, report the Olympix alerts from its comment
(`### 🤖 GitHub Action: Security Alerts Review 🔍`), print the PR link and stop. Never mark it
ready again.

## Stop conditions

Report what failed, what was tried and the PR link when:

- the same failure comes back after a fix attempt,
- a finding needs a user decision,
- Zeus has not reviewed the head SHA within 30 min of the request,
- 5 rounds have run (Phase A and B together; each Zeus request counts as one).

## Final report

```text
<PR URL> — clean | stopped: <reason> | rollout, not marked ready (draft | ready)
CI:          N passing, ignored: audit-* (expected before audit), protect-critical-code: <state>
CodeRabbit:  reviewed — T threads (F fixed, R replied) | not reviewed (rate limited)
Aikido:      I ignored, F fixed, M manual review | clean scan
Zeus:        approved | changes requested — F fixed, R replied | not reviewed
Open threads by people: <url list or none>
Rounds:      <n>
```

When clean, offer `/post-pr-for-review`.
