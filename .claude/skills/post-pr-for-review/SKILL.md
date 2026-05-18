---
name: post-pr-for-review
description: Post a LI.FI pull request to the right Slack review channel based on the source repo. Smart-contract PRs (`lifinance/contracts`) go to `#dev-sc-review` with an in-thread tag of `@smartcontract_core`; backend PRs (`lifinance/lifi-backend`, `lifinance/tenderly-sim`, and other backend-services repos) go to `#dev-backend-expansion-review` as a single top-level message with no thread and no tag. Enables auto-merge (squash) on the PR by default, posts in the channel's terse `<URL> << <title>` format. Use when the user says "post PR for review", "send for review", "share for review", "post to dev-sc-review", "post to dev-backend-expansion-review", or supplies a GitHub PR URL with intent to request review from the appropriate LI.FI team. Requires the Slack MCP server to be connected.
---

# Post PR for Review

## When to trigger

User says any of:
- "post PR for review" / "send PR to sc review" / "share for review"
- "post to dev-sc-review"
- Provides a GitHub PR URL with review intent
- `/post-pr-for-review [url]`

## Inputs

- **PR URL** (optional). If omitted, resolve from current branch via `gh pr view --json url,title,body,number`. If no PR exists for the current branch, ask the user for the URL.

## Routing — which channel based on the PR's repo

The destination channel and post shape are **derived from the PR's repo**, not from the user's phrasing. Pick the route at the start of step 1 and carry it through.

### Route A — Smart contracts (`lifinance/contracts`)

- **Channel:** `#dev-sc-review` (known ID: `C088UJWC8PR`; resolve via `slack_search_channels` if unknown)
- **Post shape:** top-level message **+** thread reply
- **Thread tag:** `@smartcontract_core` — Slack user group, subteam ID `S096X6MCB0C`
- **Mention syntax (REQUIRED):** `<!subteam^S096X6MCB0C>` — plain `@smartcontract_core` does NOT trigger notifications (verified 2026-05-13)

### Route B — Backend services

Repos that route to backend: `lifinance/lifi-backend`, `lifinance/tenderly-sim`, and other LI.FI backend-services repos (any repo under `lifinance/*` that is clearly a backend service rather than the smart-contract monorepo or a frontend).

- **Channel:** `#dev-backend-expansion-review` (resolve via `slack_search_channels`)
- **Post shape:** single top-level message only — **no thread reply, no tag**
- **Why no tag:** the channel's existing convention (verified from history) is terse PR drops without notifications; reviewers self-serve from the channel.

### Unknown repo

If the PR is from a repo you can't confidently place in Route A or Route B (e.g., a frontend repo, a tooling repo, or a private repo you haven't seen), **ask the user** which channel to post to rather than guessing. Do not invent a route.

## Format (match the channel's existing convention exactly)

Top-level message (both routes use the same shape):
```text
<PR_URL> << <PR_TITLE>
```

Example from `#dev-sc-review`:
```text
https://github.com/lifinance/contracts/pull/1776 << claude skill for creating user stories
```

Example from `#dev-backend-expansion-review`:
```text
https://github.com/lifinance/lifi-backend/pull/8345 << Add Polygon and BSC support LI.FI Intents
```

**Do not** add prefixes like "New PR:" or decorative emoji to the top-level message. Both channels are high-signal/low-noise.

Route A thread reply (first reply, posted by the same skill run):
```text
<!subteam^S096X6MCB0C> please review 🙏
```

Route B: **no thread reply.** Stop after the top-level message.

## Workflow

1. **Resolve PR + pick route**
   - If URL given, parse `owner/repo/pull/N`.
   - Else: `gh pr view --json url,title,number,body,headRefName,isDraft` (in the current repo).
   - Extract `title`, `url`, `number`, `isDraft`, plus `owner` and `repo` from the URL.
   - **Pick route from `owner/repo`** (see "Routing" section above): Route A for `lifinance/contracts`, Route B for backend repos, ask the user if unsure. Carry the chosen route through every remaining step — channel ID, post shape, and the confirmation message all depend on it.

2. **Pre-flight checks** — what you check depends on the route. The goal is simple: don't waste reviewers' attention on a PR that obviously isn't ready, but don't impose more friction than the team actually wants.

   - **Route A (SC):** run all three checks below — unresolved threads, CI status, draft status. SC reviews are expensive; we gate hard.
   - **Route B (backend):** check **unresolved review threads** + **squad label**. Skip the CI and draft checks — the backend team is fine reviewing PRs with in-progress CI.

   ### Route B — squad label requirement

   `lifinance/lifi-backend` requires every PR to carry either an `Expansion` or `Core` label (enforced by the repo's `label` CI check). Because we're posting to `#dev-backend-expansion-review`, the right label is **`Expansion`** — the channel name itself confirms the squad.

   Workflow:
   1. Check current labels: `gh pr view <N> --repo lifinance/lifi-backend --json labels --jq '.labels[].name'`
   2. If the PR already has `Expansion` or `Core` → continue.
   3. If it has neither → **add `Expansion`** without asking (the channel determines the squad; this isn't a judgment call):
      ```bash
      gh pr edit <N> --repo lifinance/lifi-backend --add-label Expansion
      ```
   4. If the user explicitly says the PR is `Core` (e.g., "post #1234 to dev-backend-expansion-review, it's core" — note: would be unusual, since Core PRs wouldn't normally go to the expansion channel), surface the contradiction and ask.

   Run pre-flight, then jump to step 3. We surface problems to the executor and let them decide what to fix — this skill does NOT auto-create fix PRs (a sibling skill, planned as `address-pr-review-comments`, owns that separate concern).

   **a) Unresolved review threads** — especially CodeRabbit, but any unresolved thread counts. REST doesn't expose `isResolved`, so use GraphQL:
   ```bash
   gh api graphql -f query='
     query($owner:String!,$repo:String!,$num:Int!){
       repository(owner:$owner,name:$repo){
         pullRequest(number:$num){
           reviewThreads(first:100){
             nodes{
               isResolved
               isOutdated
               comments(first:1){ nodes{ author{login} body url path } }
             }
           }
         }
       }
     }' -f owner=<owner> -f repo=<repo> -F num=<N> \
     --jq '.data.repository.pullRequest.reviewThreads.nodes
           | map(select(.isResolved == false and .isOutdated == false))'
   ```
   Group results by author. CodeRabbit appears as `coderabbitai` / `coderabbitai[bot]`.

   **b) CI status**
   ```bash
   gh pr checks <N>
   ```
   Treat as blockers: non-success terminal states (`FAILURE`, `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`) **except** for review-gated checks (see allowlist below). `IN_PROGRESS`/`QUEUED`/`PENDING`/`SKIPPED` is informational, not a blocker on its own.

   **Review-triggered check allowlist** — workflows wired to GitHub's `pull_request_review` event only fire *after* a reviewer submits a review. Pre-review they sit in `SKIPPED`/`PENDING`/`ACTION_REQUIRED` by design — they haven't been triggered yet. GitHub renders these in the checks list with a `(pull_request_review)` suffix on the check name. Posting to the review channel is literally how we trigger them, so blocking on them would be circular.

   Rule: ignore (don't block, don't mention) any check whose name ends in `(pull_request_review)`. This is the only allowlist criterion — it's a workflow-trigger fact, not a name-match.

   Important: the same workflow often appears twice in the checks list — once `push`-triggered (runs on every commit, expected to pass) and once `pull_request_review`-triggered (runs only on review). E.g., in `lifinance/contracts` the names `version-control`, `audit-verification`, and a few `protect-*` checks appear in both forms. The push-triggered instance is a real blocker if it fails; the `(pull_request_review)` instance is not. Match on the suffix, not the bare name.

   Some checks (e.g. `SC Core Dev Approval Check`, `Protect security-critical code/system`) only exist as `pull_request_review` workflows — they'll still match the suffix rule and be ignored automatically.

   When in doubt about an unfamiliar check, surface it to the user and ask — don't silently allowlist anything beyond the `(pull_request_review)` rule.

   **c) Draft status** — already captured from step 1 (`isDraft`).

3. **Decide based on pre-flight**

   - **Unresolved comments OR failing CI** → do NOT post. Summarize to the executor and stop (substitute the route's channel name):
     ```text
     Not posting to <#channel> yet — please resolve these first:

     Unresolved review threads (N total):
       • coderabbitai (X): <url>, <url>, ...
       • <other> (Y): <url>, ...

     Failing CI checks:
       • <check name>: <conclusion> — <details_url>

     Once addressed (push fixes, mark CodeRabbit threads resolved), re-run this skill.
     A separate skill (`address-pr-review-comments`, planned) will help draft a fix PR
     that closes review comments — keeping that concern out of this skill.
     ```
     Do not prompt to post anyway. The executor owns the call to fix vs. override.

   - **CI in progress, nothing failing yet** → tell the user, ask whether to wait or post anyway. Default: wait.

   - **Draft + everything else clean** → offer to mark ready via `gh pr ready <N>` before posting. Confirm first (visible to watchers). If user declines, ask whether to post anyway — drafts can be reviewed, but it's unusual.

   - **Everything clean and PR is ready** → proceed to step 4.

4. **Confirm with user before posting** — but skip the confirmation if the user's invoking message already constitutes consent.

   Skip confirmation when the request includes an explicit imperative to post, e.g. "post for review", "push for review", "send it", "ship it", "post to dev-sc-review", "post to dev-backend-expansion-review", "move to ready and push", or similar. In that case, post immediately and report what was posted afterward — re-asking is friction the user has already cleared.

   Otherwise (the user only named the PR, asked to "prepare" a post, or the intent is ambiguous), confirm first. Slack posts are visible to others and reversible only by deletion, so when in doubt, ask. Use the route's channel name and post shape:

   Route A (smart contracts):
   ```text
   About to post to #dev-sc-review:

     <url> << <title>

   Then reply in thread: "<!subteam^S096X6MCB0C> please review 🙏"

   Proceed? (y/n)
   ```

   Route B (backend):
   ```text
   About to post to #dev-backend-expansion-review:

     <url> << <title>

   (No thread reply, no tag — channel convention.)

   Proceed? (y/n)
   ```
   If user says yes/y/go/ship, proceed. Otherwise wait for edits.

   Note: the pre-flight gate in step 3 is the real safety net — it blocks accidental posts of broken PRs regardless of whether step 4 confirms. Step 4 is just about content/wording, which is fixed and predictable here.

5. **Enable auto-merge** — **Route A (SC) only.** Skip this step entirely on Route B; the backend team doesn't use auto-merge as a default (they prefer the author to merge after review).

   Why for SC: the reviewers' approval is the last gate. Once they approve and CI is green, the PR should merge itself — no second round-trip to the author. The reviewer's approval doubles as the merge signal.

   Command:
   ```bash
   gh pr merge <N> --repo <owner>/<repo> --auto --squash
   ```
   Squash is the LI.FI default merge method for `lifinance/contracts` and our backend repos. If a future repo uses a different default, mirror it (`--merge` or `--rebase`); when unsure, surface to the user.

   Handle these outcomes silently (just log a one-line note, then continue):
   - **Already enabled** → no-op, move on.
   - **"Pull request is already in clean status"** / mergeable now → it would merge immediately. Do NOT auto-merge before posting — disable and surface to user: "PR is already mergeable; not enabling auto-merge so the reviewers can still see it. Want me to merge now instead?"
   - **"Auto-merge is not enabled for this repository"** → skip with a note: "Auto-merge isn't enabled on this repo; posting without it." Don't ask.
   - **Any other gh error** → surface verbatim, ask whether to post anyway.

   **Opt-out**: if the user's invoking message includes "without auto-merge", "no auto-merge", "don't auto-merge", or "manual merge", skip this step entirely.

6. **Resolve channel ID** via `slack_search_channels`, using the route's channel name as the query:
   - Route A → `dev-sc-review` (known ID `C088UJWC8PR`; the search is a safety net in case it ever moves)
   - Route B → `dev-backend-expansion-review` (resolve via search; no hard-coded ID yet)

   Pick the exact-name match. If multiple results come back, prefer the non-archived public channel whose name matches exactly.

7. **Post top-level** via `slack_send_message` (both routes):
   - `channel_id`: resolved ID
   - `text`: `<url> << <title>`
   - Capture the returned `ts` (message timestamp) — only needed if the route has a thread reply.

8. **Post thread reply** — **Route A only.** Skip this step entirely on Route B.
   Via `slack_send_message`:
   - `channel_id`: same
   - `thread_ts`: the `ts` from step 7
   - `text`: `<!subteam^S096X6MCB0C> please review 🙏`

9. **Confirm to user** — include the Slack permalink (if returned), the route used, and (Route A only) the auto-merge state, e.g.:
   ```text
   Posted to #dev-sc-review ✓ — auto-merge (squash) enabled
   ```
   or for Route B:
   ```text
   Posted to #dev-backend-expansion-review ✓ (no thread, no tag, no auto-merge — backend convention)
   ```

## Failure modes

- **MCP not connected:** Tell user to connect the Slack MCP and retry. Do NOT fall back to webhooks (different identity model — see notes below).
- **Channel not found:** Surface the search results; channel may have been renamed.
- **gh CLI missing or unauthenticated:** Ask user to paste the PR URL directly; skip pre-flight checks and warn that they were skipped.
- **GraphQL query fails / rate limited:** Fall back to `gh pr view --json reviewDecision,comments` and surface raw comment count; warn that resolution-state could not be determined.

## Design notes (why this skill exists)

- Posts via Slack MCP → message appears as the *human user*, preserving thread-reply notifications and author attribution. This is the right channel etiquette for both `#dev-sc-review` and `#dev-backend-expansion-review`.
- Webhook-based posting (used by `audit-request-slack-relay` in CI) is intentionally NOT used here — it would post as a bot and lose attribution.
- No secrets stored anywhere; each teammate authenticates the Slack MCP once via their own Claude Code config.
- Route is derived from the PR's `owner/repo`, not the user's phrasing — this avoids the failure mode where the user says "post for review" but the message lands in the wrong channel because the skill defaulted to SC.

## Variations the user may request

Route A (SC) only:
- "Also @ Daniela specifically" → add `@Daniela` after the group tag in the thread reply.
- "Add context: <message>" → append the message as a second thread reply, NOT to the top-level post.
- "Quiet ping" → drop the 🙏 emoji; keep just `@smartcontract_core please review`.

Both routes:
- "Without auto-merge" / "no auto-merge" → skip step 5 entirely.
- Explicit channel override ("post to #some-other-channel") → use that channel instead of the route's default, but keep the route's post shape (thread + tag for SC-like requests, no-thread for backend-like requests) unless the user also overrides that.

Route B (backend) only:
- If the user asks to "ping someone in particular" on a backend PR, do it via a thread reply (not the top-level message) — this is a soft deviation from channel convention but acceptable when the user explicitly wants attention from a specific reviewer. Default backend behavior remains no-thread, no-tag.
