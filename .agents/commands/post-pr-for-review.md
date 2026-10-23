---
name: post-pr-for-review
description: Posts a `lifinance/contracts` PR to `#dev-sc-review`, tagging `@smartcontract_core` for SC-critical paths else `@api_expansion-squad`, and enables squash auto-merge. Use for "post PR for review", "send for review", or a contracts PR URL with review intent. Requires the Slack MCP server.
---

# Post PR for Review (Smart Contracts)

Scope: `lifinance/contracts` → `#dev-sc-review` only. For any other repo, stop and tell the user which skill or channel to use — never guess a channel, and don't extend this skill to other repos.

## Inputs

PR URL (optional). Else resolve from the current branch with `gh pr view --json url,title,body,number,headRefName,isDraft`; if no PR exists, ask for the URL.

## Channel and tag

Channel: `#dev-sc-review` (`C088UJWC8PR`).

The tag follows the `main protection` ruleset: every PR needs one API Expansion approval; PRs touching SC-critical paths also need one from Smart Contract Core. Classify from the PR's files:

```bash
files=$(gh api repos/lifinance/contracts/pulls/<N>/files --paginate \
  --jq '.[] | .filename, (.previous_filename // empty)') && [ -n "$files" ] || { echo "files lookup failed"; exit 1; }
grep -qE '^(src/|script/deploy/safe/|script/emergency/)' <<<"$files" && echo critical || echo routine
```

`previous_filename` counts, so a file renamed out of a critical path still routes to SC Core. A failed lookup stops the post — never default to `routine`.

| Result     | Group                  | Thread tag (`GROUP_TAG`) |
| ---------- | ---------------------- | ------------------------ |
| `critical` | `@smartcontract_core`  | `<!subteam^S096X6MCB0C>` |
| `routine`  | `@api_expansion-squad` | `<!subteam^S0ADCJQC9F0>` |

Keep the patterns in sync with the ruleset's `required_reviewers`. Tags must use `<!subteam^…>` form — plain `@…` does not notify.

## Post format

Top-level (no prefix, no decorative emoji): `<PR_URL> << <PR_TITLE>`

Thread reply, sent immediately after: `<GROUP_TAG> please review 🙏`

## Workflow

### 1. Resolve PR

Parse `owner/repo/pull/N`; extract `title`, `url`, `number`, `isDraft`. Apply the scope guard. Pick `GROUP_TAG`.

### 2. Pre-flight

- **Unresolved review threads** (blocking) — REST lacks `isResolved`; use GraphQL:

  ```bash
  gh api graphql -f query='
    query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          reviewThreads(first:100){
            nodes{ isResolved isOutdated
              comments(first:1){ nodes{ author{login} body url path } } } } } } }' \
    -f owner=lifinance -f repo=contracts -F num=<N> \
    --jq '.data.repository.pullRequest.reviewThreads.nodes
          | map(select(.isResolved == false and .isOutdated == false))'
  ```

  Group by author; CodeRabbit is `coderabbitai` / `coderabbitai[bot]`. If GraphQL fails, fall back to `gh pr view --json reviewDecision,comments` and treat resolution state as unknown: don't post unless the user explicitly says to go ahead.

- **Failing CI** (blocking, `gh pr checks <N>`): block on `FAILURE` / `CANCELLED` / `TIMED_OUT` / `ACTION_REQUIRED`. Ignore checks whose name ends in `(pull_request_review)` — they fire only once the PR is posted, so blocking on them is circular. Match the suffix only: `version-control` and some `protect-*` checks exist in both push and `(pull_request_review)` forms, and only the latter is exempt. Surface unfamiliar checks; don't silently widen the allowlist.

- **Audit checks are non-blocking** — `audit-verification` / `audit-*` failing or pending, in either form, does not block: peer review precedes the audit (rule `503-sc-feature-pr-lifecycle`).

- **Aikido scan** (soft gate):
  1. Probe with `aikido-mcp:aikido_full_scan` on `[{ relativeFilePath: "test.js", content: "// test" }]`.
  2. Unavailable → print `⚠ Aikido scan skipped — MCP not configured. Run /aikido:setup to enable security pre-flight.` and continue.
  3. Available → scan `git diff --name-only main...HEAD`, filter against `.agents/references/aikido-false-positive-catalog.md`.
  4. Real findings remain → run `/aikido-address-findings` and stop; don't post until clean.

### 3. Gate

- **Unresolved threads or failing CI** → don't post and don't auto-fix. List them (`<author> (count): <urls>`, `<check>: <conclusion> — <details_url>`) and ask the user to re-run after fixing.
- **CI in progress, nothing failing** → tell the user; default to waiting.
- **Draft + clean** → offer `gh pr ready <N>`; confirm first.

### 4. Confirm

Skip if the invoking message already says to post ("post for review", "ship it", "send it", "post to dev-sc-review", "move to ready and push"). Otherwise show the planned top-level + thread text and wait for go.

### 5. Auto-merge

Check merge state first — `--auto` merges a fully-approved green PR immediately, which would leave a "please review" post for an already-merged PR:

```bash
state=$(gh pr view <N> --repo lifinance/contracts \
  --json mergeStateStatus --jq '.mergeStateStatus')
```

- `CLEAN` → don't enable; tell the user "PR is already mergeable; not enabling auto-merge so reviewers can still see it. Merge now instead?"
- Otherwise → `gh pr merge <N> --repo lifinance/contracts --auto --squash`.

Already enabled → no-op. "Auto-merge is not enabled for this repository" → skip with a one-line note. Any other error → surface verbatim and ask.

### 6. Post

`slack_send_message` to `C088UJWC8PR` (if it fails, confirm the non-archived channel via `slack_search_channels` — it may have been renamed) with the top-level text; capture `ts`. Then `slack_send_message` with `thread_ts = <ts>` and the thread reply.

### 7. Report

`Posted to #<channel> ✓ — auto-merge: <enabled | already on | skipped: <reason>>` only when both sends succeeded. If the thread reply failed, report `Parent posted, thread reply (reviewer tag) failed: <error>` with the parent link instead.

## Failure modes

- **Slack MCP not connected** → ask the user to connect it. Never fall back to webhooks — the MCP posts as the user, which reviewers need for attribution and thread notifications.
- **`gh` missing / unauthenticated** → stop: tag routing, pre-flight and auto-merge all need it; ask the user to install `gh` (or fix `PATH`) if it is missing, or run `gh auth login` if it is unauthenticated.

## Variations

- "also @ <person>" → append `@<person>` after the group tag in the thread reply.
- "add context: <msg>" → a second thread reply, never the top-level.
- "quiet ping" → drop the 🙏; keep the subteam syntax.
- "tag SC core" → `<!subteam^S096X6MCB0C>` even for a routine PR.
- "without auto-merge" / "no auto-merge" / "manual merge" → skip step 5.
- Explicit channel override → resolve its ID with `slack_search_channels` and use it instead of `C088UJWC8PR` for both sends and the report; keep the post shape unless overridden too.
