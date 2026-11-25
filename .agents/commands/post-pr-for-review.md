---
name: post-pr-for-review
description: Posts a `lifinance/contracts` or `lifinance/contracts-tron` PR to `#dev-sc-review`, tagging `@smartcontract_core` for SC-critical paths else `@api_expansion-squad`, and enables squash auto-merge unless the PR is already mergeable or is a contracts-tron sync PR. Use for "post PR for review", "send for review", or a contracts / contracts-tron PR URL with review intent. Requires the Slack MCP server.
---

# Post PR for Review (Smart Contracts)

Scope: `lifinance/contracts` and `lifinance/contracts-tron` → `#dev-sc-review` only. For any other repo, stop and tell the user which skill or channel to use — never guess a channel, and don't extend this skill to other repos.

`<REPO>` below is the PR's own `owner/repo` (`<OWNER>` / `<NAME>` its parts). Every `gh` call and the GraphQL query target it — never hard-code `lifinance/contracts` for a contracts-tron PR.

## Inputs

PR URL (optional). Else resolve from the current branch with `gh pr view --json url,title,body,number,headRefName,isDraft`; if no PR exists, ask for the URL.

## Channel and tag

Channel: `#dev-sc-review` (`C088UJWC8PR`).

The tag follows the `main protection` ruleset, which has the same `required_reviewers` in both repos: every PR needs one API Expansion approval; PRs touching SC-critical paths also need one from Smart Contract Core. Classify from the PR's files:

```bash
files=$(gh api repos/<REPO>/pulls/<N>/files --paginate \
  --jq '.[] | .filename, (.previous_filename // empty)') && [ -n "$files" ] || { echo "files lookup failed"; exit 1; }
grep -qE '^(src/|script/deploy/safe/|script/emergency/)' <<<"$files" && echo critical || echo routine
```

`previous_filename` counts, so a file renamed out of a critical path still routes to SC Core. A failed lookup stops the post — never default to `routine`. The endpoint lists at most 3,000 files, so the post also stops when `gh pr view <N> --repo <REPO> --json changedFiles` exceeds that.

| Result     | Group                  | Thread tag (`GROUP_TAG`) |
| ---------- | ---------------------- | ------------------------ |
| `critical` | `@smartcontract_core`  | `<!subteam^S096X6MCB0C>` |
| `routine`  | `@api_expansion-squad` | `<!subteam^S0ADCJQC9F0>` |

A `critical` PR tags SC Core alone: every SC Core member is also in `api-expansion`, so one SC Core approval meets both rules. If that stops holding (`gh api orgs/lifinance/teams/<slug>/members`), tag both groups. Keep the patterns in sync with the ruleset's `required_reviewers` (`gh api repos/<REPO>/rulesets`); if the two repos' rulesets diverge, classify per repo. Tags must use `<!subteam^…>` form — plain `@…` does not notify.

## Post format

Top-level (no prefix, no decorative emoji): `<PR_URL> << <PR_TITLE>`

Thread reply, sent immediately after: `<GROUP_TAG> please review 🙏`

## Workflow

### 1. Resolve PR

Parse `owner/repo/pull/N` into `<REPO>` and `<N>`; extract `title`, `url`, `number`, `headRefName`, `isDraft` (`gh pr view <N> --repo <REPO> --json …`). Apply the scope guard. Record `HEAD_OID` and `BASE_REF` (`gh pr view <N> --repo <REPO> --json headRefOid,baseRefName`), then pick `GROUP_TAG` with the files lookup and 3,000-file check in "Channel and tag". Re-read both values after the lookup; if either changed, record the new values and redo the lookup, so the tag matches the recorded PR state.

### 2. Pre-flight

Every check below runs against `HEAD_OID`.

- **Unresolved review threads** (blocking) — REST lacks `isResolved`; use GraphQL:

  ```bash
  gh api graphql -f query='
    query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          reviewThreads(first:100){
            nodes{ isResolved isOutdated
              comments(first:1){ nodes{ author{login} body url path } } } } } } }' \
    -f owner=<OWNER> -f repo=<NAME> -F num=<N> \
    --jq '.data.repository.pullRequest.reviewThreads.nodes
          | map(select(.isResolved == false and .isOutdated == false))'
  ```

  Group by author; CodeRabbit is `coderabbitai` / `coderabbitai[bot]`. If GraphQL fails, fall back to `gh pr view <N> --repo <REPO> --json reviewDecision,comments` and treat resolution state as unknown: don't post unless the user explicitly says to go ahead.

- **Failing CI** (blocking, `gh pr checks <N> --repo <REPO> --json name,state,link,event`): a check passes only on `SUCCESS` / `SKIPPED` / `NEUTRAL` and is in progress only on `QUEUED` / `IN_PROGRESS` / `PENDING` / `WAITING` / `REQUESTED`; any other state (`FAILURE`, `STARTUP_FAILURE`, `CANCELLED`, an unknown one…) blocks. Ignore checks whose `event` is `pull_request_review` — they run once a reviewer acts, so blocking on them is circular. Filter on `event`, not the name: `protect-critical-code` and `protect_audit_labels` come back with bare names, and `protect_audit_labels` also runs with `event` `pull_request`, which still counts. Surface unfamiliar checks; don't silently widen the allowlist.

- **Audit checks are non-blocking** — `audit-verification` / `audit-*` failing or pending, in either form and in either repo, does not block: peer review precedes the audit (rule `503-sc-feature-pr-lifecycle`).

- **Aikido** (blocking) — CI scans every PR: the `Aikido Security: check code` row of the Failing CI call, whose findings are review threads started by `aikido-pr-checks` (GraphQL drops the `[bot]` suffix).
  - Row absent or `SKIPPED` → not scanned; block. Drafts always report `SKIPPED` (see the Gate).
  - Any Aikido thread among the unresolved threads above blocks, even on `SUCCESS`: Aikido concludes `success` with MEDIUM findings.
  - `FAILURE` (already blocking under Failing CI) with no open Aikido thread → the findings were ignored or fixed, but Aikido doesn't refresh a finished run after `@AikidoSec ignore:` replies: say so, and tell the user to push or re-run the check.
  - To clear findings, point to `/drive-pr <N>` (`lifinance/contracts` only) or `/aikido-address-findings`. Run the latter from a clone of `<REPO>` checked out on the PR's head branch (`gh pr checkout <N>` in that clone; ask before switching a checkout with uncommitted work): it resolves the PR and the repo from the current checkout, so elsewhere it triages the wrong PR.

### 3. Gate

- **Unresolved threads, failing CI or Aikido not scanned** → don't post and don't auto-fix. List them (`<author> (count): <urls>`, `<check>: <state> — <link>`) and ask the user to re-run after fixing.
- **CI in progress, nothing failing** → tell the user; default to waiting.
- **Draft + clean** (judged without the Aikido row, which is `SKIPPED` on drafts) → offer `gh pr ready <N> --repo <REPO>`; confirm first. After it, wait in the background (at most 30 min) until the Aikido row on `HEAD_OID` is complete and not `SKIPPED`, then rerun step 2 and this gate before confirming.

### 4. Confirm

Skip if the invoking message already says to post ("post for review", "ship it", "send it", "post to dev-sc-review", "move to ready and push"). Otherwise show the planned top-level + thread text and wait for go.

### 5. Post

Re-read `gh pr view <N> --repo <REPO> --json headRefOid,baseRefName` first. If either differs from `HEAD_OID` / `BASE_REF` (a push or base change during the checks, the gate or the confirm wait), redo step 1's recording and `GROUP_TAG` classification, step 2 and the gate on the new state, then compare again. Post only when both equal the values the last step 1 recorded; if either changes again on the second rerun, stop and ask the user instead of posting. If the rerun changed `GROUP_TAG`, show the new thread text and wait for go again, even when step 4 was skipped.

`slack_send_message` to `C088UJWC8PR` (if it fails, confirm the non-archived channel via `slack_search_channels` — it may have been renamed) with the top-level text; capture `ts`. Then `slack_send_message` with `thread_ts = <ts>` and the thread reply.

### 6. Auto-merge

Only after both sends succeeded; otherwise skip it and report. Check merge state first — `--auto` merges a fully-approved green PR immediately, before reviewers act on the post:

```bash
state=$(gh pr view <N> --repo <REPO> \
  --json mergeStateStatus --jq '.mergeStateStatus')
```

A contracts-tron sync PR (`<REPO>` is `lifinance/contracts-tron` and `headRefName` starts with `sync/upstream-`) must merge with a merge commit, never squash, or the fork's merge-base falls behind upstream (`docs/TronFork.md`). `MERGE_FLAG` is `--merge` for a sync PR, else `--squash`.

- Sync PR, checked first and regardless of `state` → read `gh pr view <N> --repo <REPO> --json autoMergeRequest --jq '.autoMergeRequest.mergeMethod'`. If it is `SQUASH`, run `gh pr merge <N> --repo <REPO> --disable-auto` (tell the user it was on and is now off). Then continue below with `MERGE_FLAG=--merge`; the "Otherwise" branch asks the user to skip auto-merge or enable it, instead of enabling it directly.
- `CLEAN` → don't enable; tell the user "PR is already mergeable; not enabling auto-merge so reviewers can still see it. Merge now instead?" — on yes, `gh pr merge <N> --repo <REPO> <MERGE_FLAG>`.
- Otherwise → `gh pr merge <N> --repo <REPO> --auto <MERGE_FLAG>`.

Already enabled → no-op (a sync PR's squash auto-merge was already turned off above). "Auto-merge is not enabled for this repository" → skip with a one-line note. Any other error → surface verbatim and ask.

### 7. Report

`Posted to #<channel> ✓ — auto-merge: <enabled (<squash | merge>) | already on | skipped: <reason>>` only when both sends succeeded; append `; squash auto-merge disabled` when step 6 turned one off. If the thread reply failed, report `Parent posted, thread reply (reviewer tag) failed: <error> — auto-merge was not changed by this run` with the parent link instead.

### 8. Clean up

Once posted, check the session's worktree (if one was used) with `git status --porcelain --untracked-files=all` and `git log HEAD --not --remotes` (commits on no remote branch). Both empty → remove it, so the next session starts clean. Otherwise list the uncommitted files and unpushed commits and ask the user; never discard them.

## Failure modes

- **Slack MCP not connected** → ask the user to connect it. Never fall back to webhooks — the MCP posts as the user, which reviewers need for attribution and thread notifications.
- **`gh` missing / unauthenticated** → stop: tag routing, pre-flight and auto-merge all need it; ask the user to install `gh` (or fix `PATH`) if it is missing, or run `gh auth login` if it is unauthenticated.

## Variations

- "also @ <person>" → append `@<person>` after the group tag in the thread reply.
- "add context: <msg>" → a second thread reply, never the top-level.
- "quiet ping" → drop the 🙏; keep the subteam syntax.
- "tag SC core" → `<!subteam^S096X6MCB0C>` even for a routine PR.
- "without auto-merge" / "no auto-merge" / "manual merge" → skip step 6.
- Explicit channel override → resolve its ID with `slack_search_channels` and use it instead of `C088UJWC8PR` for both sends and the report; keep the post shape unless overridden too.
