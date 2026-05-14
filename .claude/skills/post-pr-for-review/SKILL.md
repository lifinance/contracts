---
name: post-pr-for-review
description: Post a pull request to the LI.FI `#dev-sc-review` Slack channel for smart-contract team review. Enables auto-merge (squash) on the PR by default, posts the PR URL + title as a top-level message (matching the existing channel format `<URL> << <title>`), then replies in-thread tagging the `@smartcontract_core` user group. Use when the user says "post PR for review", "send to sc review", "share PR with sc team", "post to dev-sc-review", or supplies a PR URL with intent to request review from the smart-contract core team. Requires the Slack MCP server to be connected.
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

## Channel + audience (fixed)

- **Channel:** `#dev-sc-review` (resolve ID via `slack_search_channels`; known ID at time of writing: `C088UJWC8PR`)
- **Tag in thread:** `@smartcontract_core` — Slack user group, subteam ID `S096X6MCB0C`
- **Mention syntax (REQUIRED):** `<!subteam^S096X6MCB0C>` — plain `@smartcontract_core` does NOT trigger notifications (verified 2026-05-13)

## Format (match existing channel convention exactly)

Top-level message:
```
<PR_URL> << <PR_TITLE>
```

Example from the channel:
```
https://github.com/lifinance/contracts/pull/1776 << claude skill for creating user stories
```

**Do not** add prefixes like "New PR:" or emoji to the top-level message. Match the channel's terse style.

Thread reply (first reply, posted by the same skill run):
```
<!subteam^S096X6MCB0C> please review 🙏
```

That's it. No long description, no checklist. The channel is high-signal/low-noise.

## Workflow

1. **Resolve PR**
   - If URL given, parse `owner/repo/pull/N`.
   - Else: `gh pr view --json url,title,number,body,headRefName` (in the current repo).
   - Extract `title` and `url`.

2. **Confirm with user before posting** (Slack posts are visible to others — reversible only by deletion).
   Show:
   ```
   About to post to #dev-sc-review:

     <url> << <title>

   Then reply in thread: "<!subteam^S096X6MCB0C> please review 🙏"

   Proceed? (y/n)
   ```
   If user says yes/y/go/ship, proceed. Otherwise wait for edits.

3. **Enable auto-merge** (default; do this *before* posting to Slack).

   Why: the SC team's review is the last gate. Once they approve and CI is green, the PR should merge itself — no second round-trip to the author. The reviewer's approval doubles as the merge signal.

   Command:
   ```bash
   gh pr merge <N> --repo <owner>/<repo> --auto --squash
   ```
   Squash is the LI.FI default merge method for `lifinance/contracts`. If a future repo uses a different default, mirror it (`--merge` or `--rebase`); when unsure, surface to the user.

   Handle these outcomes silently (just log a one-line note, then continue):
   - **Already enabled** → no-op, move on.
   - **PR is already mergeable now** → it would merge immediately. Do NOT auto-merge before posting — surface to user: "PR is already mergeable; not enabling auto-merge so the SC team can still review. Want me to merge now instead?"
   - **Auto-merge is not enabled for this repository** → skip with a note: "Auto-merge isn't enabled on this repo; posting without it." Don't ask.
   - **Any other gh error** → surface verbatim, ask whether to post anyway.

   **Opt-out**: if the user's invoking message includes "without auto-merge", "no auto-merge", "don't auto-merge", or "manual merge", skip this step entirely.

4. **Resolve channel ID** via `slack_search_channels` (query: `dev-sc-review`). Pick the exact-name match.

5. **Post top-level** via `slack_send_message`:
   - `channel_id`: resolved ID
   - `text`: `<url> << <title>`
   - Capture the returned `ts` (message timestamp) — needed for threading.

6. **Post thread reply** via `slack_send_message`:
   - `channel_id`: same
   - `thread_ts`: the `ts` from step 5
   - `text`: `<!subteam^S096X6MCB0C> please review 🙏`

7. **Confirm to user** — include both the Slack permalink (if returned) and the auto-merge state (enabled / skipped / already-mergeable), e.g.:
   ```
   Posted ✓ — auto-merge (squash) enabled
   ```

## Failure modes

- **MCP not connected:** Tell user to connect the Slack MCP and retry. Do NOT fall back to webhooks (different identity model — see notes below).
- **Channel not found:** Surface the search results; channel may have been renamed.
- **gh CLI missing or unauthenticated:** Ask user to paste the PR URL directly.
- **PR is draft:** Warn the user and ask whether to proceed anyway.

## Design notes (why this skill exists)

- Posts via Slack MCP → message appears as the *human user*, preserving thread-reply notifications and author attribution. This is the right channel etiquette for `#dev-sc-review`.
- Webhook-based posting (used by `audit-request-slack-relay` in CI) is intentionally NOT used here — it would post as a bot and lose attribution.
- No secrets stored anywhere; each teammate authenticates the Slack MCP once via their own Claude Code config.

## Variations the user may request

- "Also @ Daniela specifically" → add `@Daniela` after the group tag in the thread reply.
- "Add context: <message>" → append the message as a second thread reply, NOT to the top-level post.
- "Quiet ping" → drop the 🙏 emoji; keep just `@smartcontract_core please review`.
