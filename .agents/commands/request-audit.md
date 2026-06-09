---
name: request-audit
description: Prepares a smart contract audit request and drafts it to Slack as you (Sujith or burrasec team) for one-click send; use when a PR is ready for external audit review.
usage: /request-audit <PR_NUMBER_OR_URL> [--urgent]
---

# Audit Request Command

> **Usage**: `/request-audit <PR_NUMBER_OR_URL> [--urgent]`

Fetch a PR, extract scope + context, compose an audit request, let the user pick the
channel(s) and optionally edit, then create a Slack **draft** (via the Slack MCP) that posts
**as the user** — the user reviews it in Slack and clicks Send.

Why a draft, not a direct post: the audit channels are **Slack Connect** (externally shared)
channels. Slack blocks every integration — including user-OAuth — from *writing* to them
(`mcp_externally_shared_channel_restricted`), so a direct `slack_send_message` fails. But
`slack_send_message_draft` is permitted: it lands an attached draft in the user's Slack that
they send manually, so the message goes out under their name rather than a bot's. The webhook
path (Step 6 fallback) is the only zero-touch option but posts as the app — prefer the draft.

---

## Channels

| Alias | Channel | Channel ID | Mention ID | Display name (manual fallback) | Greeting position |
|---|---|---|---|---|---|
| **sujith** | `#dev-sc-audit` | `C08CJ4FEHQA` | `<@U05GN6XH57T>` | `@Sujith Somraaj` | greeting **before** PR/Commit |
| **burrasec** | `#dev-sc-audit-burrasec` | `C094C46JSDP` | `<@U094M720QDP>` | `@Josip Koncurat` | PR/Commit **before** greeting |

If a channel ID ever changes, resolve it with `slack_search_channels` (the audit channels may
be private — pass `channel_types: public_channel,private_channel`).

### .env (optional — only for the webhook fallback)

The draft path needs no `.env`. The Step 6 webhook *fallback* posts to a channel `#X` via env
var `WEBHOOK_X` (uppercase, hyphens → underscores); URLs live in 1Password vault **Developers
Smart Contract**, item **Webhooks SC Channels**.

```
WEBHOOK_DEV_SC_AUDIT=https://hooks.slack.com/services/...
WEBHOOK_DEV_SC_AUDIT_BURRASEC=https://hooks.slack.com/services/...
```

---

## Step 1 — Fetch PR data

```bash
gh pr view <PR_NUMBER> --repo lifinance/contracts \
  --json number,title,body,url,headRefName,commits,files,labels,state
```

Extract: `number`, `url`, `title`, `body`, `commits[].oid` (use the **last** entry as
`latest_commit_oid` — re-run the command with `--json commits` if the array came back empty),
`files[]`, `labels[]`.

## Step 1a — Fetch linked Linear ticket

PRs in this repo are usually linked to a Linear ticket in the **EXSC** team
(`https://linear.app/lifi-linear/team/EXSC/all`); the description is high-value audit context
(motivation, design decisions, scope boundaries). Extract an `EXSC-\d+` identifier from, in
order:

1. PR body — `EXSC-\d+` token, or a `linear.app/lifi-linear/issue/EXSC-\d+/…` URL.
2. PR title — same `EXSC-\d+` pattern.
3. `headRefName` — branch like `feat/exsc-1234-…` (case-insensitive).

If found, fetch with `mcp__claude_ai_Linear__get_issue` (id = `EXSC-1234`). Treat the
description and comments as another input source for the context paragraph (Step 3). If the
ticket links a Slack thread, read it for context (Step 1b).

If no identifier is found, skip silently — don't ask the user.

## Step 1b — Enrich from Slack only if readily available (never block)

Don't stop to ask for a Slack thread — the PR plus the Linear ticket (Step 1a) are enough by
default. Pull Slack context only when it's free:

- **Linear ticket links a thread** — read it, fold decision-relevant parts into the context
  paragraph (Step 3).
- **User passed a Slack URL or note in the invocation** — use it.
- **Otherwise** — draft from PR + Linear; the user can still add detail at the Step 4 preview.

Parse a Slack URL to `channel_id` + `message_ts`, then read with `slack_read_thread`:

```
https://lifi-protocol.slack.com/archives/{channel_id}/p{ts_without_dot}
→ message_ts: insert dot after 10th digit, e.g. p1776070807528139 → 1776070807.528139
```

## Step 2 — Extract scope, context, urgency

**Scope** (contract names + versions). Try in order; prefer 1–3 over 4:

1. PR title brackets, e.g. `[GenericSwapFacetV3 v2.0.0, WithdrawablePeriphery v2.0.0, …]`
2. PR body markdown table with `| Contract | Version | … |`
3. PR body `Scope:` line
4. Fallback: distinct `.sol` filenames from `files[]` under `src/Facets|Periphery|Helpers|Libraries|Security/`

**Context** — extract from PR body: Summary / What's in this PR (2–5 sentences, drop
implementation trivia), Why / motivation, **NOT in this PR** (exclusions matter as much as
inclusions), and merge-order / multi-PR sequencing if step N of M.

**Urgency** — flag as urgent if any of: `--urgent` flag passed, PR title/body/labels mention
"urgent" / "time pressure" / "blocker" / "ASAP" / "today" or carry an urgency label, the
Linear ticket has `priority: 1` (Urgent), or the Linear ticket's `dueDate` is within ~3 days.

## Step 3 — Build the message

One self-contained message per channel that posts **as-is** — no `Audit: …` headline, no
`:thread:` ornament, no separate parent — so the user can send the draft with zero edits. Same
blocks (greeting with mention, PR + Commit, Scope, Context), two orderings by channel:

**Sujith** (greeting first):

```
Hey <@U05GN6XH57T>! {greeting_line}

PR: {pr_url}
Commit: {pr_url}/commits/{latest_commit_oid}

Scope: {full_scope_list}

{context}
```

**Burrasec** (PR/Commit first):

```
PR: {pr_url}
Commit: {pr_url}/commits/{latest_commit_oid}

Hey <@U094M720QDP>. {greeting_line}

Scope: {full_scope_list}

{context}
```

**Fields:**

- `greeting_line` — natural variation, e.g. "I have a new audit for you." / "We have a new
  contract change to audit." Append urgency: "It's a bit urgent — are you able to review this
  today?"
- `full_scope_list` — comma-separated, **every** contract with its version. Backticks per the
  code-style rule below (a draft renders inline code when sent); plain text only in the
  manual-paste fallback file.
- `context` — see next section.

### Composing the context paragraph

The **PR body** defines *what* is in this PR. The **Linear ticket** and **Slack thread**
explain *why*. Never let either expand the described scope beyond what the PR body states.

Merge all available sources into one coherent paragraph:

1. Root cause / problem (Linear ticket or Slack thread if available, else PR body Summary)
2. What this PR does — be precise about what is and isn't included
3. Key design decisions or alternatives rejected (only if relevant, keep short)
4. Urgency / deadline, if applicable

If the PR body has an explicit "NOT in this PR" / "Explicitly excluded" section, reflect those
boundaries — auditors need to know what's out of scope as much as what's in.

3–7 sentences total, written as prose (not bullets) so it reads naturally in Slack. If the
Linear ticket or Slack thread had a long discussion, extract only the decision-relevant parts;
drop back-and-forth, emoji reactions, administrative replies.

**Code style** (applies to the draft and webhook posts; only the manual-paste fallback file
uses plain text — see Step 6). Wrap in backticks every function, variable, contract, repo, error,
constant, selector, and version string — `transfer()`, `safeTransfer`, `LibAsset.transferERC20`,
`LibAsset.sol`, `contracts-tron`, `TransferFailed`, `contractSelectorIsAllowed`, `v2.1.3`. Plain
prose words (the, this, PR, etc.) are never wrapped.

## Step 4 — Preview and confirm

Show the full preview using markdown code blocks so the user sees exactly what will be drafted —
one ready-to-send message per channel (this is verbatim what the draft will contain):

````
## Audit Request Preview

**PR:** #{pr_number} — {pr_title_truncated_to_80_chars}
**Commit:** `{latest_commit_oid}`
**Urgent:** {Yes / No}

---

### Option 1: Sujith (#dev-sc-audit)

```
{message_sujith}
```

---

### Option 2: Burrasec (#dev-sc-audit-burrasec)

```
{message_burrasec}
```

---
````

Then ask:

```
Where should I draft this?
  1 — Sujith only
  2 — Burrasec only
  3 — Both channels
  4 — Cancel

Reply 1/2/3/4, or suggest edits to the message text before I create the draft.
```

**Stop. Wait for the reply.**

## Step 5 — Apply edits (if requested)

Apply, show the updated message, confirm before drafting:

```
Updated message:
[…]
Ready to create the draft? (yes / cancel)
```

## Step 6 — Create the draft (default path — posts as the user)

The Step 3 message is one self-contained Slack message that posts **as the user**: they review
the draft in Slack and click Send with no edits. Do **not** post directly — `slack_send_message`
to a Connect channel fails with `mcp_externally_shared_channel_restricted`.

For each chosen channel, **independently** (one channel failing must not abort siblings):

1. Take the Step 3 message **verbatim** (greeting-led, no `Audit:` headline, no `:thread:`).
   Keep the backtick code style and the `<@…>` API mention — a draft renders both correctly
   when sent.
2. Create the draft via the Slack MCP, using the **Channel ID** from the Channels table:

   ```
   slack_send_message_draft(channel_id = <id>, message = <the Step 3 message>)
   ```

   (`<id>` = `C08CJ4FEHQA` for sujith, `C094C46JSDP` for burrasec.)
3. Interpret the result:

| Result | Action |
|---|---|
| draft created | `✅ Draft ready in #{channel} (posts as you) — review & hit Send: {channel_link}` |
| `draft_already_exists` | Tell the user a draft is already attached to #{channel}; they should send or discard it in Slack, then re-run for that channel. Do **not** fall back to the webhook. |
| any other error | Drafting is unavailable (MCP down / no access) — fall back to the webhook (see below). |

After drafting all chosen channels, remind the user the messages are **not sent yet** — they
must open each channel and click Send.

### Fallback 1 — webhook (posts as the app/bot, not the user)

Use **only** if drafting errored for a non-`draft_already_exists` reason (e.g. the Slack MCP
isn't connected). This posts as the webhook app, so prefer the draft path. For each affected
channel:

1. Write the Step 3 message to a temp file (multi-line text mustn't be shell-quoted):
   `/tmp/audit-{pr_number}-{channel}.txt`
2. Run:

   ```bash
   bunx tsx script/utils/send-slack-webhook-message.ts \
     --channel {channel} \
     --message-file /tmp/audit-{pr_number}-{channel}.txt
   ```

   where `{channel}` is `dev-sc-audit` (sujith) or `dev-sc-audit-burrasec` (burrasec).
3. Interpret exit code:

| Exit | Meaning | Action |
|---|---|---|
| `0` | sent | `✅ Sent to #{channel} (via webhook — posted as the app)` |
| `2` | `WEBHOOK_*` env var not set for that channel | Fall back to the manual-paste file (below) for **this channel only** |
| `1` | Slack / network error | Report stderr, do **not** retry, do **not** write the manual file |

### Fallback 2 — manual-paste file (last resort)

Reached only when both drafting and the webhook are unavailable. Two transforms from the
draft/webhook version: **display-name mentions** instead of `<@…>` (Slack only resolves API
mentions through its API, not when a human pastes text), and **plain text** (no backticks —
Slack doesn't render inline code from pasted content).

Build the full file content first (one block per affected channel; omit any channel that
already drafted/posted), then write **once** to `/tmp/audit-request-{pr_number}.md` — never
write one channel and overwrite with another. Format:

```markdown
# Audit Request — PR #{pr_number}

## #{channel_name}
Post this as a new message in the channel:

---
{message — display name mentions — plain text}
---
```

Tell the user, naming only the channel(s) that fell back this far, and why (e.g. `{webhook_var}
unset` for that channel):

```
⚠️ Could not draft or webhook-post to #{channel} — wrote a manual-paste version to
   /tmp/audit-request-{pr_number}.md. Open it and paste it into the channel.
```

---

## Error handling

| Situation | Action |
|---|---|
| PR not found | Report and stop |
| Scope can't be determined | List changed `src/` files, ask user to confirm scope |
| User replies with anything other than 1–4 at the confirm step | Ask again |
| `slack_send_message` rejected with `mcp_externally_shared_channel_restricted` | Expected for Connect channels — use the draft path (Step 6), never direct send |

(Draft results and webhook exit codes `0`/`1`/`2` are handled in Step 6.)

---

## Worked example — PR #1715

**Input:** `/request-audit 1715`

**Step 1:** `gh pr view 1715 …`. Latest commit OID is the **last** `commits[]` entry:
`142d9d809e8184fff4a21605fcd41983ed2e0e4d`.

**Step 2 scope** (from PR title brackets):

```
GenericSwapFacetV3 v2.0.0, WithdrawablePeriphery v2.0.0, LiFiDEXAggregator v1.13.0,
ReceiverAcrossV3 v1.2.0, ReceiverChainflip v1.1.0, ReceiverStargateV2 v1.2.0, TokenWrapper v1.3.0
```

**Step 3 Sujith message** (single, ready-to-send — opens with the greeting, no headline):

```
Hey <@U05GN6XH57T>! I have a new audit for you.

PR: https://github.com/lifinance/contracts/pull/1715
Commit: https://github.com/lifinance/contracts/pull/1715/commits/142d9d809e8184fff4a21605fcd41983ed2e0e4d

Scope: `GenericSwapFacetV3 v2.0.0`, `WithdrawablePeriphery v2.0.0`, `LiFiDEXAggregator v1.13.0`, `ReceiverAcrossV3 v1.2.0`, `ReceiverChainflip v1.1.0`, `ReceiverStargateV2 v1.2.0`, `TokenWrapper v1.3.0`

Tron's canonical USDT contract declares `transfer()` as `returns (bool)` but omits the actual `return true` — the EVM returns 32 zero bytes, which Solady's `safeTransfer` interprets as `false` and reverts. Rather than ship Tron-specific bytecode to 60+ EVM chains, the team maintains a `contracts-tron` fork where the actual bypass lives inside `LibAsset.transferERC20`. This PR is step 1 of a two-part audit sequence: it routes every periphery ERC20 transfer through `LibAsset` so that the single fork-level change covers all call sites automatically — `LibAsset.sol` is not modified here (stays at `v2.1.3`) and the PR contains no Tron-specific code. Once this PR is audited and merged, a second audit will follow for the `contracts-tron` fork PR #9 where `LibAsset` receives the Tron USDT bypass. The same audit cycle is also used to land two breaking changes: `GenericSwapFacetV3` migrates from the legacy `contractIsAllowed` + `selectorIsAllowed` pair to the stricter `contractSelectorIsAllowed`, and `WithdrawablePeriphery` adds a `ZeroAmount` revert plus routes native transfers through `LibAsset.transferAsset`. Approval and native-ETH paths are intentionally out of scope — the Tron USDT issue is `transfer()`-only.
```

(Burrasec message is structurally identical, just `PR/Commit` first, then `Hey @Josip Koncurat. …`, same scope and same context paragraph.)

**Step 6:** Take the message above verbatim and `slack_send_message_draft(channel_id =
"C08CJ4FEHQA", message = …)` → `✅ Draft ready in #dev-sc-audit (posts as you) — review & hit
Send`. Only if the Slack MCP is unavailable does it fall back to the `WEBHOOK_DEV_SC_AUDIT`
webhook (posts as the app).

This example calibrates two things abstract rules can't: the **prose density** of the context
paragraph (5–7 sentences of compressed reasoning, never bullet-listed) and the **exact template
layout** for both auditors.
