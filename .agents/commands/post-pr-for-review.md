---
name: post-pr-for-review
description: Post a `lifinance/contracts` pull request to `#dev-sc-review` and enable auto-merge (squash). Top-level message plus a thread reply tagging `@smartcontract_core`. Use when the user says "post PR for review", "send for review", "share for review", "post to dev-sc-review", or supplies a `lifinance/contracts` PR URL with review intent. Requires the Slack MCP server.
---

# Post PR for Review (Smart Contracts)

Posts a `lifinance/contracts` pull request to `#dev-sc-review` and (optionally) enables auto-merge. This is the smart-contract variant of `post-pr-for-review` and lives in the contracts repo. Other repos (backend, frontend, tooling) have their own routing skills — do not extend this one to handle them; surface the mismatch and stop.

## Inputs

PR URL (optional). If omitted, resolve from the current branch via:

```bash
gh pr view --json url,title,body,number,headRefName,isDraft
```

If no PR exists, ask for the URL.

## Scope guard

This skill posts to `#dev-sc-review` only. If the PR's `owner/repo` is not `lifinance/contracts`, stop and tell the user which skill or channel to use instead. Do not guess a backend / frontend channel.

## Channel and tag

| Channel | Channel ID | Group tag |
|---|---|---|
| `#dev-sc-review` | `C088UJWC8PR` | `<!subteam^S096X6MCB0C>` (renders `@smartcontract_core`) |

`@smartcontract_core` MUST be sent as `<!subteam^S096X6MCB0C>` — plain `@…` does not notify (verified 2026-05-13).

## Post format

Top-level message (no prefix, no decorative emoji — channel is high-signal / low-noise):

```text
<PR_URL> << <PR_TITLE>
```

Thread reply (sent immediately after the top-level):

```text
<!subteam^S096X6MCB0C> please review 🙏
```

## Workflow

### 1. Resolve PR

Parse `owner/repo/pull/N` from URL or `gh pr view`. Extract `title`, `url`, `number`, `isDraft`. Confirm `owner/repo == lifinance/contracts`; otherwise hit the scope guard above.

### 2. Pre-flight

Two blocking checks plus one workflow branch:

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

  Group by author; CodeRabbit is `coderabbitai` / `coderabbitai[bot]`.

- **Failing CI** (blocking, `gh pr checks <N>`): block on `FAILURE` / `CANCELLED` / `TIMED_OUT` / `ACTION_REQUIRED`. Ignore any check whose name ends in `(pull_request_review)` — those are review-gated workflows that haven't fired yet; posting is what triggers them, so blocking would be circular. Match on the suffix only — `version-control` and some `protect-*` checks appear in both push and `(pull_request_review)` forms; only the latter is exempt. Surface unfamiliar checks; don't silently widen the allowlist.

- **Audit checks are NON-blocking** — a check matching `audit-verification` / `audit-*` reporting `FAILURE` (or pending) does NOT block posting, in either its push or `(pull_request_review)` form. LI.FI's flow is SC-team review *first*, then audit (Sujith): the PR is posted to `#dev-sc-review` precisely so reviewers can sign off before the audit is requested. If an audit check is red/pending, note it in a thread reply and still post. Continue to block on every non-audit failure.

- **Draft status** (workflow branch) — if drafted, offer `gh pr ready <N>`; confirm first.

### 3. Gate on pre-flight

- **Unresolved threads OR failing CI** → don't post. Summarize and stop:

  ```text
  Not posting to #dev-sc-review yet — please resolve these first:

  Unresolved review threads (N): • <author> (X): <url>, <url>…
  Failing CI: • <name>: <conclusion> — <details_url>

  Re-run after fixing.
  ```

  This skill does NOT auto-fix.

- **CI in progress, nothing failing** → tell user, default to waiting.
- **Draft + clean** → offer `gh pr ready <N>`; confirm first.
- **Clean + ready** → step 4.

### 4. Confirm

Skip confirmation if the invoking message includes explicit intent ("post for review", "ship it", "send it", "post to dev-sc-review", "move to ready and push"). Re-asking is friction the user has cleared.

Otherwise show the planned top-level + thread reply text and wait for go.

Step 3's pre-flight is the real safety net; step 4 is content-check only.

### 5. Auto-merge

First, fetch merge state — `--auto` consumes immediately on a fully-approved + green PR, which would merge the PR before step 6 posts to Slack (leaving the team a "please review" message for an already-merged PR):

```bash
state=$(gh pr view <N> --repo lifinance/contracts \
  --json mergeStateStatus --jq '.mergeStateStatus')

if [ "$state" = "CLEAN" ]; then
  # PR would merge instantly under --auto. Skip and ask the user:
  # "PR is already mergeable; not enabling auto-merge so reviewers can still see it. Merge now instead?"
else
  gh pr merge <N> --repo lifinance/contracts --auto --squash
fi
```

Squash is LI.FI's default for `lifinance/contracts`.

Silently log + continue on:

- Already enabled → no-op.
- "Auto-merge is not enabled for this repository" → skip with a one-line note.
- Any other `gh` error → surface verbatim, ask.

Opt-out: invoking message contains "without auto-merge" / "no auto-merge" / "manual merge" → skip.

### 6. Resolve channel + post

Channel ID: primary is `C088UJWC8PR`. Use `slack_search_channels` as a safety net to confirm the exact-name non-archived match if needed.

Top-level: `slack_send_message` with `text = "<url> << <title>"`. Capture `ts`.

Thread reply: `slack_send_message` with `thread_ts = <ts>`, `text = "<!subteam^S096X6MCB0C> please review 🙏"`.

### 7. Report

```text
Posted to #dev-sc-review ✓ — auto-merge (squash) enabled
```

## Failure modes

- **MCP not connected** → ask user to connect Slack MCP. Do NOT fall back to webhooks (wrong identity).
- **Channel not found** → surface search results; may have been renamed.
- **`gh` missing / unauthenticated** → ask for URL, skip pre-flight, warn.
- **GraphQL fails** → fall back to `gh pr view --json reviewDecision,comments` with a warning that resolution state is unknown.

## Variations

- "also @ <person>" → append `@<person>` after the group tag in the thread reply.
- "add context: <msg>" → append as a second thread reply, never the top-level.
- "quiet ping" → drop the 🙏; thread reply becomes `<!subteam^S096X6MCB0C> please review`. Keep the subteam syntax — plain `@smartcontract_core` does not notify.
- "without auto-merge" → skip step 5.
- Explicit channel override → use that channel; keep the post shape unless overridden too.

## Why this design

Slack MCP posts as the human user, preserving thread-reply notifications and attribution — right etiquette for review channels. Webhook posting (used by `audit-request-slack-relay`) is intentionally NOT used here (wrong identity). No secrets stored; each teammate authenticates the MCP themselves.

The skill is intentionally scoped to `lifinance/contracts` → `#dev-sc-review` only. A multi-repo dispatcher (SC + backend + others) lives outside the contracts repo; mixing routing logic into this file invites the wrong-channel posts the routing rule was meant to prevent.
