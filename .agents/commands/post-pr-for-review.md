---
name: post-pr-for-review
description: Posts a `lifinance/contracts` or `lifinance/contracts-tron` PR to `#dev-sc-review`, tagging `@smartcontract_core` for contracts-tron and for SC-critical contracts paths else `@api_expansion-squad`, and enables squash auto-merge unless the PR is already mergeable or is a contracts-tron sync PR. Use for "post PR for review", "send for review", or a contracts / contracts-tron PR URL with review intent. Requires the Slack MCP server.
---

# Post PR for Review (Smart Contracts)

Scope: `lifinance/contracts` and `lifinance/contracts-tron` → `#dev-sc-review` only. For any other repo, stop and tell the user which skill or channel to use — never guess a channel, and don't extend this skill to other repos.

`<REPO>` below is the PR's own `owner/repo` (`<OWNER>` / `<NAME>` its parts). Every `gh` call, the GraphQL query and the Aikido fetch target it — never hard-code `lifinance/contracts` for a contracts-tron PR.

## Inputs

PR URL (optional). Else resolve from the current branch with `gh pr view --json url,title,body,number,headRefName,isDraft`; if no PR exists, ask for the URL.

## Channel and tag

Channel: `#dev-sc-review` (`C088UJWC8PR`).

**`lifinance/contracts-tron`**: always `critical` (tag `@smartcontract_core`), whatever files the PR touches — that repo's `main protection` ruleset requires one Smart Contract Core approval on `**`. Still run the files lookup below: the 3,000-file stop and the Aikido scan need it.

**`lifinance/contracts`**: the tag follows the `main protection` ruleset: every PR needs one API Expansion approval; PRs touching SC-critical paths also need one from Smart Contract Core. Classify from the PR's files:

```bash
files=$(gh api repos/<REPO>/pulls/<N>/files --paginate \
  --jq '.[] | .filename, (.previous_filename // empty)') && [ -n "$files" ] || { echo "files lookup failed"; exit 1; }
grep -qE '^(src/|script/deploy/safe/|script/emergency/)' <<<"$files" && echo critical || echo routine
```

`previous_filename` counts, so a file renamed out of a critical path still routes to SC Core. A failed lookup stops the post — never default to `routine`. The endpoint lists at most 3,000 files, so the post also stops when `gh pr view <N> --repo <REPO> --json changedFiles` exceeds that (routing and the Aikido scan both read this list).

| Result     | Group                  | Thread tag (`GROUP_TAG`) |
| ---------- | ---------------------- | ------------------------ |
| `critical` | `@smartcontract_core`  | `<!subteam^S096X6MCB0C>` |
| `routine`  | `@api_expansion-squad` | `<!subteam^S0ADCJQC9F0>` |

A `critical` PR tags SC Core alone: every SC Core member is also in `api-expansion`, so one SC Core approval meets both rules. If that stops holding (`gh api orgs/lifinance/teams/<slug>/members`), tag both groups. Keep the patterns in sync with the ruleset's `required_reviewers`. Tags must use `<!subteam^…>` form — plain `@…` does not notify.

## Post format

Top-level (no prefix, no decorative emoji): `<PR_URL> << <PR_TITLE>`

Thread reply, sent immediately after: `<GROUP_TAG> please review 🙏`

## Workflow

### 1. Resolve PR

Parse `owner/repo/pull/N` into `<REPO>` and `<N>`; extract `title`, `url`, `number`, `headRefName`, `isDraft` (`gh pr view <N> --repo <REPO> --json …`). Apply the scope guard. Pick `GROUP_TAG`.

### 2. Pre-flight

Record `HEAD_OID` (`gh pr view <N> --repo <REPO> --json headRefOid`) before any check, even when the Aikido scan is skipped; every check below runs against that head.

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

- **Failing CI** (blocking, `gh pr checks <N> --repo <REPO> --json name,state,link`): a check passes only on `SUCCESS` / `SKIPPED` / `NEUTRAL` and is in progress only on `QUEUED` / `IN_PROGRESS` / `PENDING` / `WAITING` / `REQUESTED`; any other state (`FAILURE`, `STARTUP_FAILURE`, `CANCELLED`, an unknown one…) blocks. Ignore checks whose name ends in `(pull_request_review)` — they fire only once the PR is posted, so blocking on them is circular. Match the suffix only: `version-control` and some `protect-*` checks exist in both push and `(pull_request_review)` forms, and only the latter is exempt. Surface unfamiliar checks; don't silently widen the allowlist.

- **Audit checks are non-blocking** — `audit-verification` / `audit-*` failing or pending, in either form and in either repo, does not block: peer review precedes the audit (rule `503-sc-feature-pr-lifecycle`).

- **Aikido scan** (soft gate):
  1. Probe with `aikido-mcp:aikido_full_scan` on `[{ relativeFilePath: "test.js", content: "// test" }]`.
  2. Unavailable → print `⚠ Aikido scan skipped — MCP not configured. Run /aikido:setup to enable security pre-flight.` and continue.
  3. Available → scan the PR's files, skipping deletions (`gh api repos/<REPO>/pulls/<N>/files --paginate --jq '.[] | select(.status != "removed") | .filename'`), with their contents at the exact PR head: read `gh pr view <N> --repo <REPO> --json headRefOid` before and after the file list and retry until both match, so the list and the contents come from the same head; then `git fetch https://github.com/<REPO>.git pull/<N>/head` (works for fork PRs too, and from a checkout whose `origin` is the other repo), then `git show <headRefOid>:<path>` — never the local checkout or a same-named branch. Filter against `.agents/references/aikido-false-positive-catalog.md`. If the file list, the fetch or any `git show` fails, the scan result is unknown: don't post, and report which step failed.
  4. Real findings remain → stop; don't post until clean. Run `/aikido-address-findings` from a clone of `<REPO>` checked out on the PR's head branch (`gh pr checkout <N>` in that clone; ask before switching a checkout with uncommitted work): it resolves the PR and the repo from the current checkout, so elsewhere it triages the wrong PR.

### 3. Gate

- **Unresolved threads or failing CI** → don't post and don't auto-fix. List them (`<author> (count): <urls>`, `<check>: <state> — <link>`) and ask the user to re-run after fixing.
- **CI in progress, nothing failing** → tell the user; default to waiting.
- **Draft + clean** → offer `gh pr ready <N> --repo <REPO>`; confirm first.

### 4. Confirm

Skip if the invoking message already says to post ("post for review", "ship it", "send it", "post to dev-sc-review", "move to ready and push"). Otherwise show the planned top-level + thread text and wait for go.

### 5. Post

Re-read `gh pr view <N> --repo <REPO> --json headRefOid` first. If it differs from `HEAD_OID` (a push during the checks, the gate or the confirm wait), redo the classification in "Channel and tag" (re-pick `GROUP_TAG`), step 2 and the gate on the new head, then compare again. Post only when the current head equals the `HEAD_OID` the last step 2 recorded; if the head changes again on the second rerun, stop and ask the user instead of posting.

`slack_send_message` to `C088UJWC8PR` (if it fails, confirm the non-archived channel via `slack_search_channels` — it may have been renamed) with the top-level text; capture `ts`. Then `slack_send_message` with `thread_ts = <ts>` and the thread reply.

### 6. Auto-merge

Only after both sends succeeded; otherwise skip it and report. Check merge state first — `--auto` merges a fully-approved green PR immediately, before reviewers act on the post:

```bash
state=$(gh pr view <N> --repo <REPO> \
  --json mergeStateStatus --jq '.mergeStateStatus')
```

- `CLEAN` → don't enable; tell the user "PR is already mergeable; not enabling auto-merge so reviewers can still see it. Merge now instead?"
- contracts-tron sync PR (`<REPO>` is `lifinance/contracts-tron` and `headRefName` starts with `sync/upstream-`) → never `--squash`: a sync PR must merge with a merge commit, or the fork's merge-base falls behind upstream (`docs/TronFork.md`). Ask the user: skip auto-merge, or enable it with `gh pr merge <N> --repo <REPO> --auto --merge`.
- Otherwise → `gh pr merge <N> --repo <REPO> --auto --squash`.

Already enabled → no-op, except on a contracts-tron sync PR: read `gh pr view <N> --repo <REPO> --json autoMergeRequest --jq '.autoMergeRequest.mergeMethod'`, and if it is `SQUASH`, ask the user to disable it (`gh pr merge <N> --repo <REPO> --disable-auto`) and then skip auto-merge or re-enable it with `--merge`. "Auto-merge is not enabled for this repository" → skip with a one-line note. Any other error → surface verbatim and ask.

### 7. Report

`Posted to #<channel> ✓ — auto-merge: <enabled | already on | skipped: <reason>>` only when both sends succeeded. If the thread reply failed, report `Parent posted, thread reply (reviewer tag) failed: <error> — auto-merge was not changed by this run` with the parent link instead.

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
