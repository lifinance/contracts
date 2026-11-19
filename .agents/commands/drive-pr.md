---
name: drive-pr
description: Drives an open lifinance/contracts PR to clean without pausing — fixes failing CI, answers and resolves every CodeRabbit thread, triages Aikido, marks the draft ready and repeats on the checks that only run on ready PRs. Use for "drive the PR", "get the PR clean", "fix CI and CodeRabbit", after pushing reviewer fixes, or as the last step of create-pr.
usage: /drive-pr [<PR number | PR URL>] — defaults to the current branch's PR
---

# Drive PR

Takes an open PR to **clean**: CI green apart from the exempt checks, every CodeRabbit thread
answered and resolved, Aikido triaged, PR ready for review.

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
- **Rollout PR** (every changed file under `deployments/`): this skill never marks it ready. Run
  Phase A rounds only and report its actual draft or ready state.

## Pushing rules

- Before each push, run the tests and linters scoped to the files the fix touched.
- Signed commits (`git commit -S`); a signing failure stops the skill.
- Never `--no-verify`, never force-push. A failing pre-commit hook is fixed like a failing check.
- Never add `audit/auditLog.json` entries, never set or remove `AuditRequired`,
  `AuditNotRequired` or `AuditCompleted`.

## Phases

Several checks skip drafts, including the unit tests, `version-control`, `verify-signed-commits`
and `Aikido Security: check code`.

- **Phase A (draft)**: rounds until no blocking check, CodeRabbit settled and no open CodeRabbit
  thread, then `gh pr ready`. Already ready → Phase B.
- **Phase B (ready)**: rounds on the new check runs until clean.
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
     `neutral` / `Review rate limited` and `skipped` / `Review paused` (auto-paused after
     several reviewed commits) = **not** reviewed, though `gh pr checks` shows them passing.
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

**Not reviewed** (rate limited or paused): comment `@coderabbitai review` once per head SHA, with
the marker `<!-- drive-pr head <SHA> -->` on its own line; skip if a PR comment already carries
that marker. It runs one review without un-pausing. Then wait as in step 1 until the newest run
is reviewed. Still not reviewed once all else is clean → carry on and report
"CodeRabbit not reviewed (<title>)". Never count it as reviewed.

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

## Zeus QA review

Zeus (`lifi-qa-agent[bot]`, from the QA team) reviews ready PRs against their Linear ticket on
its own, hours later. Its approval is not part of clean: never wait for it. When its review is
`CHANGES_REQUESTED`, handle its findings like CodeRabbit threads in step 4 (reply
`Fixed in <sha>: <what changed>` or with evidence, then resolve); deferring a correct finding to
a follow-up ticket is a user decision. Once every finding has a fix or a reply, push, then
re-request Zeus so it reads them: remove and re-add the `Agent Review Request` label
(`qa-review-trigger.yml` fires on `labeled`):

```bash
gh api -X DELETE "repos/lifinance/contracts/issues/<N>/labels/Agent%20Review%20Request" || true
gh api -X POST repos/lifinance/contracts/issues/<N>/labels -f "labels[]=Agent Review Request"
```

The label turning into `QA AI Reviewing` confirms the request; don't wait for the review.

## After `gh pr ready`

`securityAlertsReview` turns the PR back to draft when an Olympix alert on it is open, dismissed
without a comment, or dismissed as "used in tests". Its comment starts with
`### 🤖 GitHub Action: Security Alerts Review 🔍`. Take each open alert from
`code-scanning/alerts?pr=<N>` (`tool.name` `Olympix Integrated Security`) and check it against
the code:

- Real → fix it like a failing check.
- False positive → dismiss it: `PATCH code-scanning/alerts/<number>` with `state=dismissed`,
  `dismissed_reason` `false positive` (or `won't fix` when real but not reachable or not worth
  changing) and a `dismissed_comment` naming the code that makes it safe. Never
  `used in tests`: only production code is analysed.
- Unsure → stop condition.

Then push any fixes, `gh pr ready` again (the workflow runs only on `ready_for_review`) and wait
for `check-security-alerts` as in step 1. Back to draft a second time → stop.

## Stop conditions

Report what failed, what was tried and the PR link when:

- the same failure comes back after a fix attempt,
- a finding needs a user decision,
- 5 rounds have run (Phase A and B together).

## Final report

```text
<PR URL> — clean | stopped: <reason> | rollout, not marked ready (draft | ready)
CI:          N passing, ignored: audit-* (expected before audit), protect-critical-code: <state>
CodeRabbit:  reviewed — T threads (F fixed, R replied) | not reviewed (rate limited | paused)
Aikido:      I ignored, F fixed, M manual review | clean scan
Olympix:     D dismissed (each with reason), F fixed | no alerts | not run (no src/**/*.sol)
Zeus:        F fixed, R replied, re-requested | no open findings
Open threads by people: <url list or none>
Rounds:      <n>
```

When clean, offer `/post-pr-for-review`.
