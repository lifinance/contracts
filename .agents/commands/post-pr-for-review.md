---
name: post-pr-for-review
description: Posts a `lifinance/contracts` or `lifinance/contracts-tron` PR to `#dev-sc-review`, tagging `@smartcontract_core` for SC-critical paths else `@api_expansion-squad`, and enables squash auto-merge unless the PR is already mergeable or is a contracts-tron sync PR. Use for "post PR for review", "send for review", or a contracts / contracts-tron PR URL with review intent. Requires the Slack MCP server.
---

# Post PR for Review (Smart Contracts)

Only `lifinance/contracts` and `lifinance/contracts-tron` PRs, only to `#dev-sc-review` (`C088UJWC8PR`). Any other repo → stop and tell the user; never guess a channel. `<REPO>` is the PR's own `owner/repo`; every `gh` call targets it.

Input: a PR URL, else the current branch's PR (`gh pr view`); none → ask.

## Tag

Classify from the PR's files, renames' `previous_filename` included:

```bash
files=$(gh api repos/<REPO>/pulls/<N>/files --paginate \
  --jq '.[] | .filename, (.previous_filename // empty)') && [ -n "$files" ] || { echo "files lookup failed"; exit 1; }
grep -qE '^(src/|script/deploy/safe/|script/emergency/)' <<<"$files" && echo critical || echo routine
```

A failed lookup, or `changedFiles` over 3,000 (the endpoint's limit), stops the post; never default to `routine`.

| Result     | `GROUP_TAG`                                       |
| ---------- | ------------------------------------------------- |
| `critical` | `<!subteam^S096X6MCB0C>` (`@smartcontract_core`)  |
| `routine`  | `<!subteam^S0ADCJQC9F0>` (`@api_expansion-squad`) |

This mirrors the `main protection` ruleset's `required_reviewers` (`gh api repos/<REPO>/rulesets`): every PR needs API Expansion, critical paths also SC Core, and every SC Core member is in API Expansion, so SC Core alone covers both. If either stops holding, update the patterns or tag both. Plain `@…` doesn't notify; use `<!subteam^…>`.

## Workflow

### 1. Resolve

Read `title`, `url`, `headRefName`, `isDraft`, and record `HEAD_OID` / `BASE_REF` (`headRefOid`, `baseRefName`). Pick `GROUP_TAG`. If `HEAD_OID` or `BASE_REF` changed during the lookup, record them again and redo it.

### 2. Pre-flight (on `HEAD_OID`)

- **Unresolved threads** (blocking): GraphQL `reviewThreads(first:100)` with `isResolved`, `isOutdated` and the first comment's `author{login} url`; keep `isResolved == false and isOutdated == false`, grouped by author. GraphQL fails → thread state is unknown: don't post; report it.
- **Failing CI** (blocking): `gh pr checks <N> --repo <REPO> --json name,state,link,event`. Pass: `SUCCESS` / `SKIPPED` / `NEUTRAL`. In progress: `QUEUED` / `IN_PROGRESS` / `PENDING` / `WAITING` / `REQUESTED`. Anything else blocks.
  - Ignore checks whose `event` is `pull_request_review`: they run once a reviewer acts. Filter on `event`, not the name; a same-named check with another `event` (e.g. `protect_audit_labels` on `pull_request`) still counts.
  - Ignore `audit-*`: peer review precedes the audit.
- **Aikido** (blocking): CI's `Aikido Security: check code` row; its findings are threads started by `aikido-pr-checks` (GraphQL drops `[bot]`).
  - Absent or `SKIPPED` → not scanned.
  - An open Aikido thread blocks even on `SUCCESS` (Aikido passes with MEDIUM findings).
  - `FAILURE` with no open Aikido thread → likely ignored or fixed findings, since Aikido doesn't refresh a finished run after `@AikidoSec ignore:` replies. Say so with the check's link and tell the user to push or re-run the check.
  - To clear findings: `/drive-pr <N>` (contracts only), or `/aikido-address-findings` from a clone checked out on the PR's head (it reads the PR from the checkout). The latter doesn't resolve threads: a fixed finding's thread blocks until resolved or outdated.

### 3. Gate

- **Unresolved threads, failing CI, or Aikido not scanned on a ready PR** → don't post or auto-fix. List them (`<author> (count): <urls>`, `<check>: <state> — <link>`).
- **CI in progress, nothing failing** → wait.
- **Draft, otherwise clean** (Aikido skips drafts) → offer `gh pr ready <N> --repo <REPO>`, confirming first. Then wait in the background, up to 30 min, until every non-ignored check the draft skipped has a newer `completed` run on `HEAD_OID` (newest by `started_at` from `repos/<REPO>/commits/<HEAD_OID>/check-runs?check_name=<name>`; Aikido's not `skipped`) and the `gh pr checks` set is stable across two polls 30 s apart. Re-run step 2 and the gate. Not settled by then → report and don't post.

### 4. Confirm

Skip when the request already says to post ("post for review", "ship it", "send it", "move to ready and push"). Otherwise show both messages and wait for go.

### 5. Post

Re-read `headRefOid` / `baseRefName`. Changed → redo steps 1–3; changed again → stop and ask. A new `GROUP_TAG` needs a fresh go.

`slack_send_message` to `C088UJWC8PR`: `<PR_URL> << <PR_TITLE>` (no prefix or emoji); capture `ts`. Then reply in that thread: `<GROUP_TAG> please review 🙏`. A send fails → check the channel with `slack_search_channels` (it may have been renamed).

### 6. Auto-merge

Only after both sends succeed. `MERGE_FLAG` is `--merge` for a contracts-tron sync PR (`headRefName` starts with `sync/upstream-`; squashing breaks the fork's merge-base, `docs/TronFork.md`), else `--squash`.

- Sync PR with squash auto-merge on → `gh pr merge <N> --repo <REPO> --disable-auto` and tell the user. For a sync PR, ask before enabling auto-merge.
- `mergeStateStatus` is `CLEAN` → don't enable (`--auto` would merge before reviewers see it); offer to merge now with `MERGE_FLAG`.
- Otherwise → `gh pr merge <N> --repo <REPO> --auto <MERGE_FLAG>`. Already on → no-op; "not enabled for this repository" → skip with a note; other errors → show and ask.

### 7. Report

`Posted to #<channel> ✓ — auto-merge: <enabled (squash | merge) | already on | skipped: <reason>>`, plus `; squash auto-merge disabled` when step 6 turned it off. Thread reply failed → report that with the parent link; auto-merge untouched.

### 8. Clean up

A worktree used for this session with no uncommitted files and no unpushed commits → remove it. Otherwise list them and ask; never discard.

## Failures

- No Slack MCP → ask the user to connect it; never use webhooks (reviewers need the post to come from the user).
- No `gh` or not authenticated → stop and say which.

## Variations

- "also @ <person>" → append to the thread reply.
- "add context: <msg>" → a second thread reply.
- "quiet ping" → drop the 🙏.
- "tag SC core" → SC Core tag regardless.
- "no auto-merge" / "manual merge" → skip step 6.
- Named channel → resolve its ID with `slack_search_channels` and use it throughout.
