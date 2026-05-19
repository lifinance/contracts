---
name: request-audit
description: Prepare and send a smart contract audit request to Slack (Sujith or burrasec team)
usage: /request-audit <PR_NUMBER_OR_URL> [--urgent]
---

# Audit Request Command

> **Usage**: `/request-audit <PR_NUMBER_OR_URL> [--urgent]`

Fetch a PR, extract scope + context, draft an audit request (parent post + thread reply),
let the user pick the channel(s) and optionally edit, then post to Slack only after explicit
confirmation.

---

## Channels

| Alias | Channel | Mention ID | Display name (manual fallback) | Greeting position |
|---|---|---|---|---|
| **sujith** | `#dev-sc-audit` | `<@U05GN6XH57T>` | `@Sujith Somraaj` | greeting **before** PR/Commit |
| **burrasec** | `#dev-sc-audit-burrasec` | `<@U094M720QDP>` | `@Josip Koncurat` | PR/Commit **before** greeting |

### .env (one-time per developer)

Convention: a channel `#X` is posted to via env var `WEBHOOK_X` (uppercase, hyphens → underscores).
URLs live in 1Password vault **Engineering**, item **slack-webhooks**.

```
WEBHOOK_DEV_SC_AUDIT=https://hooks.slack.com/services/...
WEBHOOK_DEV_SC_AUDIT_BURRASEC=https://hooks.slack.com/services/...
```

If a var is unset, that channel falls back to a manual file (see Step 6, exit 2).

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
ticket links a Slack thread, surface it as a default in Step 1b.

If no identifier is found, skip silently — don't ask the user.

## Step 1b — Always ask for additional context

After fetching, before drafting, ask:

```
Before I draft the message, do you have a Slack thread or any other background where this
change was discussed? (e.g. design decisions, root cause, alternatives considered, urgency
reason)

Paste a Slack thread URL, write a few sentences, or press Enter to skip.
```

**Wait for the reply.** Then:

- **Slack thread URL** — parse to `channel_id` + `message_ts`:
  ```
  https://lifi-protocol.slack.com/archives/{channel_id}/p{ts_without_dot}
  → message_ts: insert dot after 10th digit, e.g. p1776070807528139 → 1776070807.528139
  ```
  Read with `slack_read_thread`, then distill 3–6 sentences covering: root cause / problem,
  alternatives considered + why rejected, decision rationale, urgency signals.
- **Free-form text** — use as-is, lightly cleaned.
- **Skip** — use only PR-body context.

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

## Step 3 — Build the messages

### Parent (channel post)

```
Audit: {scope_summary} {urgency_suffix} :thread:
```

- `scope_summary` — plain text, no backticks. 2–3 contracts: list all comma-separated. 4+
  contracts: `{first} + N more`, e.g. `GenericSwapFacetV3 v2.0.0 + 6 more`.
- `urgency_suffix` — `(urgent)` if urgent, else omit the placeholder entirely.

Examples:

```
Audit: DeBridgeDlnFacet v1.1.0 :thread:
Audit: GenericSwapFacetV3 v2.0.0 + 6 more :thread:
Audit: Patcher v1.0.1 (urgent) :thread:
```

### Thread reply (one template, two variants by channel)

Both channels use the same blocks — greeting (with mention), PR + Commit, Scope, Context —
in two orderings:

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
  code-style rule below when posting via webhook; plain text in the manual-fallback file.
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

**Code style** (applies to webhook posts; the manual-fallback file deliberately uses plain
text — see Step 6 exit 2). Wrap in backticks every function, variable, contract, repo, error,
constant, selector, and version string — `transfer()`, `safeTransfer`, `LibAsset.transferERC20`,
`LibAsset.sol`, `contracts-tron`, `TransferFailed`, `contractSelectorIsAllowed`, `v2.1.3`. Plain
prose words (the, this, PR, etc.) are never wrapped.

## Step 4 — Preview and confirm

Show the full preview using markdown code blocks so the user sees exactly what will be posted:

````
## Audit Request Preview

**PR:** #{pr_number} — {pr_title_truncated_to_80_chars}
**Commit:** `{latest_commit_oid}`
**Urgent:** {Yes / No}

---

### Option 1: Sujith (#dev-sc-audit)

**Parent message:**
```
{parent_message}
```

**Thread reply:**
```
{thread_reply_sujith}
```

---

### Option 2: Burrasec (#dev-sc-audit-burrasec)

**Parent message:**
```
{parent_message}
```

**Thread reply:**
```
{thread_reply_burrasec}
```

---
````

Then ask:

```
Where should I send this?
  1 — Sujith only
  2 — Burrasec only
  3 — Both channels
  4 — Cancel

Reply 1/2/3/4, or suggest edits to the message text before I send.
```

**Stop. Wait for the reply.**

## Step 5 — Apply edits (if requested)

Apply, show the updated message, confirm before sending:

```
Updated message:
[…]
Ready to send? (yes / cancel)
```

## Step 6 — Send

For each chosen channel, **independently** (one channel failing must not abort siblings):

1. Build the combined message: parent + blank line + thread reply, with `:thread:` dropped
   from the parent — incoming webhooks can't thread, so we collapse to one self-contained
   message. Use the backtick code style.
2. Write it to a temp file (multi-line text mustn't be shell-quoted):
   `/tmp/audit-{pr_number}-{channel}.txt`
3. Run:
   ```bash
   bunx tsx script/utils/send-slack-webhook-message.ts \
     --channel {channel} \
     --message-file /tmp/audit-{pr_number}-{channel}.txt
   ```
   where `{channel}` is `dev-sc-audit` (sujith) or `dev-sc-audit-burrasec` (burrasec).
4. Interpret exit code:

| Exit | Meaning | Action |
|---|---|---|
| `0` | sent | `✅ Sent to #{channel}` |
| `2` | `WEBHOOK_*` env var not set for that channel | Manual fallback for **this channel only** — see below |
| `1` | Slack / network error | Report stderr, do **not** retry, do **not** write fallback |

### Exit 2 — manual fallback (per channel)

Two transforms from the webhook version: **display-name mentions** instead of `<@…>` (Slack
only resolves API mentions through its API, not when pasted), and **plain text** (no
backticks — Slack doesn't render inline code from externally-pasted content).

Build the full file content first (one block per fallback channel; omit any channel that
already posted), then write **once** to `/tmp/audit-request-{pr_number}.md` — never write one
channel and overwrite with another. Format:

```markdown
# Audit Request — PR #{pr_number}

## #{channel_name}

### Parent message
Post this as a new message in the channel:

---
{parent message — display name mentions — plain text}
---

### Thread reply
Reply to the parent message with this (click the reply icon on the parent):

---
{thread reply — display name mentions — plain text}
---
```

Tell the user, naming only the channel(s) that fell back. Print one line per failed channel,
substituting `{webhook_var}` with the exact missing env var (`WEBHOOK_DEV_SC_AUDIT` or
`WEBHOOK_DEV_SC_AUDIT_BURRASEC`):

```
⚠️ {webhook_var} is not set in .env — wrote manual fallback for #{channel} to
   /tmp/audit-request-{pr_number}.md. Set the env var (URL in 1Password -> Developers
   Smart Contract -> Webhooks SC Channels) to post automatically next time.
```

---

## Error handling

| Situation | Action |
|---|---|
| PR not found | Report and stop |
| Scope can't be determined | List changed `src/` files, ask user to confirm scope |
| User replies with anything other than 1–4 at the confirm step | Ask again |

(Helper exit codes `0`/`1`/`2` are handled in Step 6.)

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

**Step 3 parent:** `Audit: GenericSwapFacetV3 v2.0.0 + 6 more :thread:`

**Step 3 Sujith thread reply:**

```
Hey <@U05GN6XH57T>! I have a new audit for you.

PR: https://github.com/lifinance/contracts/pull/1715
Commit: https://github.com/lifinance/contracts/pull/1715/commits/142d9d809e8184fff4a21605fcd41983ed2e0e4d

Scope: `GenericSwapFacetV3 v2.0.0`, `WithdrawablePeriphery v2.0.0`, `LiFiDEXAggregator v1.13.0`, `ReceiverAcrossV3 v1.2.0`, `ReceiverChainflip v1.1.0`, `ReceiverStargateV2 v1.2.0`, `TokenWrapper v1.3.0`

Tron's canonical USDT contract declares `transfer()` as `returns (bool)` but omits the actual `return true` — the EVM returns 32 zero bytes, which Solady's `safeTransfer` interprets as `false` and reverts. Rather than ship Tron-specific bytecode to 60+ EVM chains, the team maintains a `contracts-tron` fork where the actual bypass lives inside `LibAsset.transferERC20`. This PR is step 1 of a two-part audit sequence: it routes every periphery ERC20 transfer through `LibAsset` so that the single fork-level change covers all call sites automatically — `LibAsset.sol` is not modified here (stays at `v2.1.3`) and the PR contains no Tron-specific code. Once this PR is audited and merged, a second audit will follow for the `contracts-tron` fork PR #9 where `LibAsset` receives the Tron USDT bypass. The same audit cycle is also used to land two breaking changes: `GenericSwapFacetV3` migrates from the legacy `contractIsAllowed` + `selectorIsAllowed` pair to the stricter `contractSelectorIsAllowed`, and `WithdrawablePeriphery` adds a `ZeroAmount` revert plus routes native transfers through `LibAsset.transferAsset`. Approval and native-ETH paths are intentionally out of scope — the Tron USDT issue is `transfer()`-only.
```

(Burrasec reply is structurally identical, just `PR/Commit` first, then `Hey @Josip Koncurat. …`, same scope and same context paragraph.)

**Step 6:** Helper sends to `dev-sc-audit` (`WEBHOOK_DEV_SC_AUDIT`); exit `0` → ✅. If unset
→ exit `2` → manual fallback for that channel only.

This example calibrates two things abstract rules can't: the **prose density** of the context
paragraph (5–7 sentences of compressed reasoning, never bullet-listed) and the **exact template
layout** for both auditors.
