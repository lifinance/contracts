---
name: post-pr-for-review
description: Post a LI.FI pull request to the right Slack review channel based on the source repo. `lifinance/contracts` → `#dev-sc-review` (top-level + thread tag `@smartcontract_core`); `lifinance/lifi-backend`, `lifinance/tenderly-sim`, and other backend services → `#dev-backend-expansion-review` (top-level only, no tag). Enables auto-merge (squash, SC route only). Use when the user says "post PR for review", "send for review", "share for review", "post to dev-sc-review", "post to dev-backend-expansion-review", or supplies a GitHub PR URL with review intent. Requires the Slack MCP server.
---

# Post PR for Review

## Inputs

PR URL (optional). If omitted, resolve from current branch via `gh pr view --json url,title,body,number,headRefName,isDraft`. If no PR exists, ask for the URL.

## Routing

Derived from the PR's `owner/repo`, not from user phrasing. Pick at step 1, carry through.

| Route | Trigger repos | Channel | Channel ID | Post shape | Auto-merge |
|---|---|---|---|---|---|
| **A — SC** | `lifinance/contracts` | `#dev-sc-review` | `C088UJWC8PR` | top-level + thread reply tagging `<!subteam^S096X6MCB0C>` | yes (squash) |
| **B — Backend** | `lifinance/lifi-backend`, `lifinance/tenderly-sim`, other backend services | `#dev-backend-expansion-review` | resolve via `slack_search_channels` | top-level only, no tag | no |

`@smartcontract_core` MUST be sent as `<!subteam^S096X6MCB0C>` — plain `@…` does not notify (verified 2026-05-13).

For unknown repos (frontend, tooling, etc.) — ask the user. Do not guess.

## Post format (both routes)

Top-level:

```text
<PR_URL> << <PR_TITLE>
```

No prefixes ("New PR:"), no decorative emoji. Both channels are high-signal / low-noise.

Route A thread reply:

```text
<!subteam^S096X6MCB0C> please review 🙏
```

## Workflow

### 1. Resolve PR + pick route

Parse `owner/repo/pull/N` from URL or `gh pr view`. Extract `title`, `url`, `number`, `isDraft`, `owner`, `repo`. Pick route from `owner/repo` per table above.

### 2. Pre-flight

| Check | Route A | Route B |
|---|---|---|
| Unresolved review threads | ✓ | ✓ |
| Failing CI | ✓ | skip |
| Draft status | ✓ | skip |
| Squad label | — | ✓ (`Expansion`) |

**Unresolved threads** (REST lacks `isResolved`; use GraphQL):

```bash
gh api graphql -f query='
  query($owner:String!,$repo:String!,$num:Int!){
    repository(owner:$owner,name:$repo){
      pullRequest(number:$num){
        reviewThreads(first:100){
          nodes{ isResolved isOutdated
            comments(first:1){ nodes{ author{login} body url path } } } } } } }' \
  -f owner=<owner> -f repo=<repo> -F num=<N> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes
        | map(select(.isResolved == false and .isOutdated == false))'
```

Group by author; CodeRabbit is `coderabbitai` / `coderabbitai[bot]`.

**CI** (`gh pr checks <N>`): block on `FAILURE`/`CANCELLED`/`TIMED_OUT`/`ACTION_REQUIRED`. Ignore any check whose name ends in `(pull_request_review)` — those are review-gated workflows that haven't fired yet; posting is what triggers them, so blocking would be circular. Match on the suffix only — `version-control`, `audit-verification`, and some `protect-*` checks appear in both push and `(pull_request_review)` forms; only the latter is exempt. Surface unfamiliar checks; don't silently widen the allowlist.

**Squad label (Route B)**:

```bash
gh pr view <N> --repo <owner>/<repo> --json labels --jq '.labels[].name'
```

If neither `Expansion` nor `Core` present → `gh pr edit <N> --repo <owner>/<repo> --add-label Expansion`. The channel determines the squad — not a judgment call. If user explicitly says it's `Core`, surface the contradiction.

### 3. Gate on pre-flight

- **Unresolved threads OR failing CI** → don't post. Summarize and stop:

  ```text
  Not posting to <#channel> yet — please resolve these first:

  Unresolved review threads (N): • <author> (X): <url>, <url>…
  Failing CI: • <name>: <conclusion> — <details_url>

  Re-run after fixing.
  ```

  The executor owns fix vs. override; this skill does NOT auto-fix (sibling `address-pr-review-comments` planned).

- **CI in progress, nothing failing** → tell user, default to waiting.
- **Draft + clean** → offer `gh pr ready <N>` (Route A); confirm first.
- **Clean + ready** → step 4.

### 4. Confirm

Skip confirmation if the invoking message includes explicit intent ("post for review", "ship it", "send it", "post to dev-sc-review", "post to dev-backend-expansion-review", "move to ready and push"). Re-asking is friction the user has cleared.

Otherwise show the planned post (URL + title + thread reply text on Route A) and wait for go.

Step 3's pre-flight is the real safety net; step 4 is content-check only.

### 5. Auto-merge — Route A only

```bash
gh pr merge <N> --repo <owner>/<repo> --auto --squash
```

Squash is LI.FI's default for contracts and backend repos.

Silently log + continue on:

- Already enabled → no-op.
- "Auto-merge is not enabled for this repository" → skip with a one-line note.
- Already mergeable → do NOT auto-merge before posting; surface: "PR is already mergeable; not enabling auto-merge so reviewers can still see it. Merge now instead?"
- Any other `gh` error → surface verbatim, ask.

Opt-out: invoking message contains "without auto-merge" / "no auto-merge" / "manual merge" → skip.

### 6. Resolve channel + post

Channel ID via `slack_search_channels` (use known ID `C088UJWC8PR` as primary for Route A; search is the safety net). Pick the exact-name non-archived match.

Top-level (both routes): `slack_send_message` with `text = "<url> << <title>"`. Capture `ts`.

Thread reply (Route A only): `slack_send_message` with `thread_ts = ts`, `text = "<!subteam^S096X6MCB0C> please review 🙏"`.

### 7. Report

Include permalink, route, and (Route A) auto-merge state:

```text
Posted to #dev-sc-review ✓ — auto-merge (squash) enabled
```

```text
Posted to #dev-backend-expansion-review ✓ (no thread, no tag, no auto-merge — backend convention)
```

## Failure modes

- **MCP not connected** → ask user to connect Slack MCP. Do NOT fall back to webhooks (wrong identity).
- **Channel not found** → surface search results; may have been renamed.
- **`gh` missing / unauthenticated** → ask for URL, skip pre-flight, warn.
- **GraphQL fails** → fall back to `gh pr view --json reviewDecision,comments` with a warning that resolution state is unknown.

## Variations

- Route A: "also @ <person>" → append `@<person>` after the group tag in thread reply.
- Route A: "add context: <msg>" → append as a second thread reply, never the top-level.
- Route A: "quiet ping" → drop the 🙏, just `@smartcontract_core please review`.
- Both: "without auto-merge" → skip step 5.
- Both: explicit channel override → use that channel; keep the route's post shape unless overridden too.
- Route B: "ping <person>" → do it via thread reply (soft deviation from convention, OK when explicit).

## Why this design

Slack MCP posts as the human user, preserving thread-reply notifications and attribution — right etiquette for both review channels. Webhook posting (used by `audit-request-slack-relay`) is intentionally NOT used here (wrong identity). No secrets stored; each teammate authenticates the MCP themselves. Route is derived from `owner/repo`, not phrasing, to avoid wrong-channel posts when the user says "post for review" generically.
