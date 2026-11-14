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

## Inputs

PR number or URL. Without one: `gh pr view --json number,url`; if that finds no PR, ask.

## Preflight

```bash
gh pr view <N> --json number,url,isDraft,isCrossRepository,author,headRefName,headRefOid
gh api user -q .login
gh api repos/lifinance/contracts/pulls/<N>/files --paginate --jq '.[].filename'
```

- **Fork or someone else's PR** (`isCrossRepository` true, or `author.login` ≠ current user):
  stop before the first push unless the user said to drive it.
- **Local branch**: be on `headRefName` with a clean tree. Not on it → `gh pr checkout <N>`;
  dirty tree → stop and ask. Then `git pull --ff-only` so local matches the PR head.
- **Rollout PR**: when every changed file starts with `deployments/`, the PR is never marked
  ready. Run Phase A only and report that it was left as a draft.

## Pushing rules

- Commits are signed (`git commit -S`); a signing failure stops the skill.
- Never `--no-verify`, never force-push. A failing pre-commit hook is fixed like a failing check.
- Before each push, run the tests and linters relevant to the fix (`099-finish`).
- Never add `audit/auditLog.json` entries. Never set or remove `AuditRequired`,
  `AuditNotRequired` or `AuditCompleted`. Never dismiss Olympix alerts.

## Phases

New PRs open as drafts, and several checks skip drafts: `version-control`,
`verify-signed-commits` and `Aikido Security: check code` all report `SKIPPED` on a draft.

- **Phase A (draft)**: run rounds until A-clean, then `gh pr ready <N>`. If the PR is already
  ready, go straight to Phase B.
- **Phase B (ready)**: run rounds again on the new check runs. **Clean is judged in Phase B
  only**; a `SKIPPED` from a draft never counts as a pass for those checks.

A-clean: no blocking check, CodeRabbit settled, no open CodeRabbit thread.
Clean (Phase B): the same, plus Aikido settled and triaged, and `securityAlertsReview` passed
when it ran.

## One round

### 1. Wait for checks to settle

Never wait with a foreground polling loop. Save the script below to a file in the session
scratchpad and run `bash <file>` in the background (Claude Code: Bash `run_in_background`; an
inline multi-line command is refused in a worktree session). Continue when it reports.
`<SHA>` is the pushed head (`git rev-parse HEAD`); `<PHASE>` is `A` or `B`; `<SOL>` is `1`
when the PR changes `src/**/*.sol`, else `0`.

```bash
N=<N>; SHA=<SHA>; PHASE=<PHASE>; SOL=<SOL>; REPO=lifinance/contracts
run_state() {
  gh api "repos/$REPO/commits/$SHA/check-runs?check_name=$1" \
    --jq '.check_runs[0] | "\(.status) \(.conclusion) \(.output.title)"'
}
for _ in $(seq 1 90); do
  head=$(gh pr view "$N" --repo "$REPO" --json headRefOid -q .headRefOid)
  [ "$head" = "$SHA" ] && break
  sleep 20
done
[ "$head" = "$SHA" ] || { echo "HEAD MOVED: PR head is $head, expected $SHA"; exit 1; }
gh pr checks "$N" --repo "$REPO" --watch --interval 30 >/dev/null 2>&1 || true
waits="CodeRabbit"
[ "$PHASE" = B ] && waits="$waits Aikido%20Security%3A%20check%20code version-control verify-signed-commits"
[ "$PHASE" = B ] && [ "$SOL" = 1 ] && waits="$waits check-security-alerts"
for _ in $(seq 1 90); do
  pending=""
  for c in $waits; do
    case "$(run_state "$c")" in
      "completed skipped"*) pending="$pending $c" ;;
      completed*) ;;
      *) pending="$pending $c" ;;
    esac
  done
  [ -z "$pending" ] && break
  sleep 20
done
for c in $waits; do echo "$c: $(run_state "$c")"; done
[ -z "$pending" ] || echo "NOT SETTLED:$pending"
gh pr view "$N" --repo "$REPO" --json headRefOid,isDraft
gh pr checks "$N" --repo "$REPO" --json name,state,event,workflow,link
```

`gh pr checks --watch` can return before the bot checks or the ready-only checks register, hence
the second loop. In Phase B it waits for `version-control`, `verify-signed-commits`, Aikido and
(for Solidity PRs) `check-security-alerts` to complete with a conclusion other than `skipped`, so
a draft's `SKIPPED` on the same SHA is never read as a pass. No check run on `<SHA>` means it has
not started.

- `HEAD MOVED` → someone else pushed: `git pull --ff-only` and start the round on the new head.
- `NOT SETTLED` after 30 min → treat those checks as failures not caused by the diff.
- Never report clean unless the final `headRefOid` equals `<SHA>`.

Bot settled states:

| Check run | Settled | Notes |
| --- | --- | --- |
| `CodeRabbit` (app `coderabbitai`) | `completed` | `success` / `Finished` = reviewed. `neutral` / `Review rate limited` = **not** reviewed, even though `gh pr checks` shows it as passing |
| `Aikido Security: check code` (app `aikido-pr-checks`) | `completed`, any conclusion except `skipped` | `success` / `Scan completed` = clean scan, with no comment. Any other conclusion is read in step 5 |

### 2. Classify every check

From `gh pr checks <N> --json name,state,event,workflow,link`:

- **Pass**: `SUCCESS` / `SKIPPED` / `NEUTRAL`. **In progress**: `QUEUED` / `IN_PROGRESS` /
  `PENDING` / `WAITING` / `REQUESTED` → wait again. **Anything else blocks.**
- **Ignored**:
  - `audit-verification`, `audit-closure-drift` and every other `audit-*` check: expected red
    until the audit is filed (stage 9).
  - Checks whose `event` is `pull_request_review`: they run once a reviewer acts.
- **Human gate**: `protect-critical-code` (`HUMAN_GATE_RE` in `script/utils/check-open-prs.ts`).
  Report its state; never try to fix it.
- **Not exempt**: `version-control` runs in the same `VersionControlAndAuditVerification`
  workflow as the audit checks, but a missing contract version bump is a real failure.
- **CodeRabbit rate limited** is handled in step 4, not as a pass.

### 3. Fix blocking checks

- **Actions check** (`link` contains `/actions/runs/<run-id>/`):
  `gh run view <run-id> --log-failed`, fix, commit, push.
- **Other check run** (`link` is external or `/runs/<check-run-id>`):
  `gh api repos/lifinance/contracts/check-runs/<check-run-id> --jq '.output'`.
- **Not caused by the diff** (infra error, rate limit, missing secret, `CANCELLED` or a run
  superseded by a later push; the `*-required` aggregators then fail too): re-run once with
  `gh run rerun <run-id> --failed`. Same failure again → stop and report it as not caused by
  the PR.

### 4. CodeRabbit

**Rate limited** (`neutral` / `Review rate limited`): post `@coderabbitai review` at most once
per head SHA. Skip the post if the PR already has that comment from you, created after the head
commit:

```bash
gh api repos/lifinance/contracts/commits/<SHA> --jq .commit.committer.date
gh pr view <N> --json comments \
  --jq '.comments[] | select(.body | startswith("@coderabbitai review")) | {author: .author.login, createdAt}'
gh pr comment <N> --body "@coderabbitai review"
```

If it is still rate limited once everything else is clean, carry on and put
"CodeRabbit not reviewed (rate limited)" in the final report. Never count it as reviewed.

**Threads**: the `main protection` ruleset requires every review thread to be resolved, so
outdated threads count too.

```bash
gh api graphql --paginate -f query='
  query($owner:String!,$repo:String!,$num:Int!,$endCursor:String){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100,after:$endCursor){
          pageInfo{ hasNextPage endCursor }
          nodes{ id isResolved isOutdated path
            comments(first:1){ nodes{ author{login} databaseId body url } } } } } } }' \
  -f owner=lifinance -f repo=contracts -F num=<N> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)'
```

For each unresolved thread whose first comment is by `coderabbitai`:

1. Check the claim against the current code at `path`. Don't take it on trust.
2. Correct → fix it (commits go out with this round's push), reply `Addressed in <sha>`.
   Wrong or not worth it → reply with the reasoning. Outdated and no longer true → reply
   `No longer applies: <why>`.
3. Resolve it.

```bash
gh api graphql -f query='mutation($id:ID!,$b:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$b}){comment{url}}}' \
  -f id=<thread-id> -f b='<reply>'
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' \
  -f id=<thread-id>
```

Reply to and resolve fixed threads after the step 6 push, so `<sha>` is on the PR. A finding
that needs a design or scope decision is a stop condition.

Threads by people stay open: resolving them is the reviewer's call. List them in the report.

### 5. Aikido (Phase B)

Once its check run has settled, run `/aikido-address-findings pr unattended`. It reads the
check run's conclusion itself, skips findings whose thread is already resolved, ignores catalog
false positives and commits fixes; this skill pushes them. Then resolve each Aikido thread whose
finding was ignored or fixed. A **Manual review** finding or a failed scan is a stop condition.

### 6. Push and repeat

Push all of the round's commits together, reply to and resolve the threads they fix, then start
the next round on the new SHA.

## After `gh pr ready`

- When the PR changes `src/**/*.sol`, `securityAlertsReview.yml` (job `check-security-alerts`)
  runs on `ready_for_review`; the Phase B wait (`SOL=1`) holds until it has completed.
- If it turns the PR back to draft (`gh pr view <N> --json isDraft`), report the Olympix alerts
  from its comment (starts with `### 🤖 GitHub Action: Security Alerts Review 🔍`), print the PR
  link and stop. Never dismiss alerts and never mark the PR ready again.
- Handle new bot comments as in steps 4 and 5.

## Stop conditions

Stop and report what failed, what was tried and the PR link when:

- the same failure comes back after a fix attempt,
- a finding needs a user decision,
- 5 rounds have run (Phase A and Phase B together).

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
