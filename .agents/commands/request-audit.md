---
name: request-audit
description: Prepare and send a smart contract audit request to Slack (Sujith or burrasec team)
usage: /request-audit <PR_NUMBER_OR_URL> [--urgent]
---

# Audit Request Command

> **Usage**: `/request-audit <PR_NUMBER_OR_URL> [--urgent]`

## Purpose

Fetch a PR, extract its scope and context, draft an audit request (parent post + thread reply), let the user choose the channel(s) and optionally edit the message, then post to Slack only after explicit confirmation.

**CRITICAL**: Never post to Slack without the user explicitly confirming at Step 4.

---

## Channels

| Alias | Channel | Slack ID | Auditors | API mention | Display name | Greeting |
|---|---|---|---|---|---|---|
| **sujith** | `#dev-sc-audit` | `C08CJ4FEHQA` | Sujith Somraaj | `<@U05GN6XH57T>` | `@Sujith Somraaj` | `Hey @Sujith Somraaj!` |
| **burrasec** | `#dev-sc-audit-burrasec` | `C094C46JSDP` | Josip | `<@U094M720QDP>` | `@Josip Koncurat` | `Hey @Josip Koncurat.` |

> **Slack ID note**: the Burrasec ID `<@U094M720QDP>` was previously paired with a wrong display name — re-verify it (and Sujith's) via Slack admin before relying on either. Webhooks paste the ID verbatim, so a wrong ID renders as `@Unknown` or pings the wrong person.

## Setup (one-time, per developer)

Direct posting uses Slack incoming webhooks read from `.env`. Add:

```
WEBHOOK_DEV_SC_AUDIT=https://hooks.slack.com/services/...
WEBHOOK_DEV_SC_AUDIT_BURRASEC=https://hooks.slack.com/services/...
```

URLs live in 1Password vault **Engineering**, item **slack-webhooks**.
Convention is reusable — any channel `#X` is posted to via `WEBHOOK_X` where the channel name is uppercased and hyphens become underscores (e.g. `#dev-sc-audit` → `WEBHOOK_DEV_SC_AUDIT`).
If a variable is unset, that channel falls back to writing the manual file to `/tmp/audit-request-{pr}.md`.

---

## Step 1 — Fetch PR Data

Run and collect all fields:

```bash
gh pr view <PR_NUMBER> --repo lifinance/contracts \
  --json number,title,body,url,headRefName,commits,files,labels,state
```

Extract:
- **`number`** and **`url`** — used in messages verbatim
- **`title`** — primary source for contract names and versions
- **`body`** — source for Summary, scope table, context
- **`commits`** array — take the **last entry's `oid`** as the latest commit hash
- **`files`** — filter to `src/**` paths only; used as fallback scope
- **`labels`** — check for `AuditRequired`, urgency signals

If the `commits` array is empty or missing, run separately:

```bash
gh pr view <PR_NUMBER> --repo lifinance/contracts --json commits
```

---

## Step 1b — Gather Additional Context (Always Ask)

**After fetching the PR but before drafting the message**, always ask the user:

```
Before I draft the message, do you have a Slack thread or any other background
where this change was discussed? (e.g. design decisions, root cause, alternatives
considered, urgency reason)

Paste a Slack thread URL, write a few sentences, or press Enter to skip.
```

**Wait for the user's reply.**

### If the user provides a Slack thread URL

Parse the URL to extract `channel_id` and `message_ts`:

```
URL format: https://lifi-protocol.slack.com/archives/{channel_id}/p{ts_without_dot}
Example:    https://lifi-protocol.slack.com/archives/C088UJW2DPZ/p1776070807528139
→ channel_id: C088UJW2DPZ
→ message_ts: 1776070807.528139   (insert dot after 10th digit)
```

Read the thread with `slack_read_thread` (channel_id + message_ts), then synthesize:

- **Root cause / background**: What problem prompted this change?
- **Alternatives considered**: What other approaches were discussed and why were they rejected?
- **Decision rationale**: Why was this specific approach chosen?
- **Any urgency signals**: Deadlines, blockers, business impact mentioned?

Distill into 3–6 sentences of rich background. This will be appended to (or replace) the PR-body context in the thread reply, giving auditors the full picture.

### If the user provides free-form text

Use it as-is (lightly cleaned up) as additional context.

### If the user skips (presses Enter / says "no")

Use only the PR body context from Step 2. That is fine — this step is optional.

---

## Step 2 — Extract Scope, Context, and Urgency

### Scope (contract names + versions)

Try these sources in order:

1. **PR title**: Many titles list all contracts with versions inside `[...]` brackets, e.g.:
   `route ERC20 transfers [...] [GenericSwapFacetV3 v2.0.0, WithdrawablePeriphery v2.0.0, ...]`
   Extract everything inside `[...]` if it looks like a contract list.

2. **PR body markdown table**: Look for a `| Contract | Version | Change |` table and extract
   the `Contract` + `Version` columns.

3. **PR body "Scope:" line**: e.g. `Scope: WhitelistManagerFacet v1.1.0, SwapperV2 v1.2.0`

4. **Changed `src/` files** (fallback): List distinct contract filenames from `files[]`
   where path starts with `src/Facets/`, `src/Periphery/`, `src/Helpers/`, `src/Libraries/`,
   or `src/Security/`. Strip the `.sol` extension.

Always prefer sources 1–3 over fallback 4.

### Context (reason for audit)

The PR body is authoritative for *what* this PR does. The Slack thread (if any) explains *why* but must never expand the described scope.

Extract from:
1. **Summary / What's in this PR** — 2–5 technical sentences; drop implementation trivia
2. **Why / motivation** — root cause
3. **NOT in this PR / Explicitly excluded** — exclusions matter as much as inclusions
4. **Merge order / multi-PR sequencing** — if this is step N of M, surface it explicitly so auditors know a follow-up audit is coming (e.g. "step 1 of 2; second audit for the `contracts-tron` fork follows")

### Urgency

Automatically flag as urgent if any of:
- `--urgent` flag was passed to the command
- PR title or body mentions "urgent", "time pressure", "blocker", "ASAP", "today"
- Labels include any urgency-related label

---

## Step 3 — Build Messages

### 3a. Parent message (channel post)

Short, one-line summary. Format:

```
Audit: {scope_summary}{urgency_suffix} :thread:
```

Where:
- `scope_summary` = the most prominent contract + version. Plain text always.
  If there are 2–3 contracts total: list them all, comma-separated.
  If there are 4+ contracts: use the first one + ` + N more`, e.g. `GenericSwapFacetV3 v2.0.0 + 6 more`.
- `urgency_suffix` = ` (urgent)` if urgent, else empty.

Examples:
```
Audit: DeBridgeDlnFacet v1.1.0 :thread:
Audit: PolymerCCTPFacet v2.0.1 :thread:
Audit: GenericSwapFacetV3 v2.0.0 + 6 more :thread:
Audit: Patcher v1.0.1 (urgent) :thread:
```

### 3b. Thread reply — Sujith channel

Structure: greeting first, then PR/Commit/Scope/Context.

Template:
```
Hey <@U05GN6XH57T>! {greeting_line}

PR: {pr_url}
Commit: {commit_url}

Scope: {full_scope_list}

{context}
```

- `greeting_line`: Pick naturally — e.g. "Hope you are great, I have a new audit for you." / "We have a new contract change to audit." / "I have a new audit request for you."
  Add urgency if applicable: "It's a bit urgent — are you able to review this today?"
- `commit_url`: `{pr_url}/commits/{latest_commit_oid}` (always use `/commits/` format)
- `full_scope_list`: comma-separated list of ALL contract names with versions. Backticks per the code style rule when posting via webhook; plain text in the manual fallback file (Step 6b).
- `context`: merged context — see below

### Context field composition

The PR body defines *what* is in this PR. The Slack thread explains *why*. Never let the thread
expand the described scope beyond what the PR body states.

Combine PR-body and Slack thread context into one coherent block:

1. **Lead with the root cause / problem** (from Slack thread if available, else PR body Summary)
2. **Explain what this PR does** (from PR body — be precise about what is and isn't included)
3. **Note key design decisions or alternatives rejected** (from Slack thread, if relevant — keep it short)
4. **Add urgency or deadline** if applicable

If the PR body contains an explicit "NOT in this PR" or "Explicitly excluded" section, reflect those
boundaries in the context — auditors need to know what is out of scope as much as what is in scope.

Aim for 3–7 sentences total. Do not bullet-list this section — write it as prose so it reads naturally in Slack.

**Code style**: Wrap in backticks every function name, variable name, contract name, repo name, error name, constant, selector, and version string — e.g. `transfer()`, `safeTransfer`, `LibAsset.transferERC20`, `LibAsset.sol`, `contracts-tron`, `TransferFailed`, `contractSelectorIsAllowed`, `v2.1.3`. Plain prose words (the, this, PR, etc.) are never wrapped. (Backticks render correctly via webhook; Step 6b's manual fallback file uses plain text instead — see that section.)

If the Slack thread had a long discussion, extract only the decision-relevant parts; drop back-and-forth, emoji reactions, and administrative replies.

### 3c. Thread reply — Burrasec channel

Structure: PR/Commit first, then greeting + Scope/Context.

Template:
```
PR: {pr_url}
Commit: {commit_url}

Hey <@U094M720QDP>. {greeting_line}

Scope: {full_scope_list}

{context}
```

- `greeting_line`: e.g. "I hope you are doing great. I have a new audit for you." / "We've got a new audit request."
  Add urgency if applicable: "This is a bit time-sensitive — could you review it today?"
- `full_scope_list`: same as Sujith — backticks via webhook, plain text in manual fallback file
- `context`: same merged context as Sujith (same background applies to both channels)

---

## Step 4 — Show Preview and Ask for Confirmation

Display the full preview in this exact format — use markdown code blocks so the user sees exactly what will be posted:

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

Reply with 1, 2, 3, or 4. You can also suggest edits to the message text before I send.
```

**Stop here. Wait for the user's reply before doing anything else.**

---

## Step 5 — Apply Edits (if any)

If the user requests changes to the message text, apply them and show the updated message inline. Confirm the change is correct before sending:

```
Updated message:
[show the edited version]

Ready to send? (yes / cancel)
```

---

## Step 6 — Send Messages

Channel arg by alias:
- **sujith** → `dev-sc-audit`
- **burrasec** → `dev-sc-audit-burrasec`

For each chosen channel, **independently** (do not abort sibling channels if one fails):

1. **Build the combined message text** (parent + blank line + thread reply, with the `:thread:` suffix dropped from the parent — incoming webhooks can't thread, so we collapse to one self-contained message). Use backtick code style.

2. **Write it to a temp file** so multi-line text isn't shell-quoted:
   ```
   /tmp/audit-{pr_number}-{channel}.txt
   ```

3. **Run the helper**:
   ```bash
   bunx tsx script/utils/send-slack-webhook-message.ts \
     --channel {channel} \
     --message-file /tmp/audit-{pr_number}-{channel}.txt
   ```

4. **Interpret exit code**:
   | Exit | Meaning | Action |
   |---|---|---|
   | `0` | sent | print `✅ Sent to #{channel}` |
   | `2` | webhook env var not set for that channel | fall through to Step 6b **for this channel only** — write its block to `/tmp/audit-request-{pr}.md` and tell the user which `WEBHOOK_*` var to set |
   | `1` | Slack/network error | report stderr to user, do NOT retry, do NOT write fallback file |

Process channels independently — if Sujith webhook is set but Burrasec isn't, post Sujith and write the manual file for Burrasec only.

### Step 6b — Manual fallback

**Triggered per-channel** when the helper exits `2` (webhook env var not set for that channel). Channels that posted successfully (exit `0`) are not included; channels that errored at the network/Slack layer (exit `1`) do **not** trigger a fallback either — only the missing-env-var case does.

If both chosen channels exit `2`, both get fallback blocks in the same file. If one channel posted (`0`) and the other is missing its env var (`2`), only the missing one gets a fallback block.

For each channel that needs a fallback block:

1. Use **display name mentions** (e.g. `@Sujith Somraaj`, `@Josip Koncurat`) instead of API mentions (`<@U05GN6XH57T>`) — API mention syntax is only resolved by Slack's API, not when typed/pasted manually.
2. Use **plain text** (no backticks) — Slack does not render backtick inline code when content is pasted from an external file.

Write all needing-fallback blocks to `/tmp/audit-request-{pr_number}.md` in a **single write** — never write one channel then overwrite with another. Build the full file content first (omit any channel that already posted successfully), then write once. Format:

```markdown
# Audit Request — PR #{pr_number}

## #{channel_name}   ← e.g. dev-sc-audit (one block per channel that exited 2; omit channels that already posted)

### Parent message
Post this as a new message in the channel:

---
{parent message — display name mentions — plain text, no backticks}
---

### Thread reply
Reply to the parent message with this (click the reply icon on the parent):

---
{thread reply — display name mentions — plain text, no backticks}
---

## #{next_channel_name}   ← include only if this channel also exited 2
…
```

Then tell the user, listing only the channel(s) that fell back:

```
⚠️ WEBHOOK_{CHANNEL_UPPER} is not set in .env — wrote manual fallback for #{channel} to
   /tmp/audit-request-{pr_number}.md. Set the env var (URL in 1Password →
   Engineering → slack-webhooks) to post automatically next time.
```

---

## Error Handling

Helper exit codes (`0`/`1`/`2`) are handled in Step 6 — not repeated here.

| Situation | Action |
|---|---|
| PR not found | Report error and stop |
| PR has no commits | Try separate `gh pr view --json commits`; if still empty, ask user for commit hash |
| Scope cannot be determined | List changed `src/` files and ask user to confirm scope before continuing |
| User types something other than 1–4 | Ask again |

---

## Worked Example — PR #1715

**Input**: `/request-audit 1715`

**Step 1** — `gh pr view 1715 …` returns title, body, commits, files. Latest commit OID is the **last** entry in `commits[]`: `142d9d809e8184fff4a21605fcd41983ed2e0e4d`.

**Step 2** — Scope (from PR title brackets):

```
GenericSwapFacetV3 v2.0.0, WithdrawablePeriphery v2.0.0, LiFiDEXAggregator v1.13.0,
ReceiverAcrossV3 v1.2.0, ReceiverChainflip v1.1.0, ReceiverStargateV2 v1.2.0, TokenWrapper v1.3.0
```

**Step 3 — Parent**:

```
Audit: GenericSwapFacetV3 v2.0.0 + 6 more :thread:
```

**Step 3 — Thread reply (Sujith)**:

```
Hey <@U05GN6XH57T>! I have a new audit for you.

PR: https://github.com/lifinance/contracts/pull/1715
Commit: https://github.com/lifinance/contracts/pull/1715/commits/142d9d809e8184fff4a21605fcd41983ed2e0e4d

Scope: `GenericSwapFacetV3 v2.0.0`, `WithdrawablePeriphery v2.0.0`, `LiFiDEXAggregator v1.13.0`, `ReceiverAcrossV3 v1.2.0`, `ReceiverChainflip v1.1.0`, `ReceiverStargateV2 v1.2.0`, `TokenWrapper v1.3.0`

Tron's canonical USDT contract declares `transfer()` as `returns (bool)` but omits the actual `return true` — the EVM returns 32 zero bytes, which Solady's `safeTransfer` interprets as `false` and reverts. Rather than ship Tron-specific bytecode to 60+ EVM chains, the team maintains a `contracts-tron` fork where the actual bypass lives inside `LibAsset.transferERC20`. This PR is step 1 of a two-part audit sequence: it routes every periphery ERC20 transfer through `LibAsset` so that the single fork-level change covers all call sites automatically — `LibAsset.sol` is not modified here (stays at `v2.1.3`) and the PR contains no Tron-specific code. Once this PR is audited and merged, a second audit will follow for the `contracts-tron` fork PR #9 where `LibAsset` receives the Tron USDT bypass. The same audit cycle is also used to land two breaking changes: `GenericSwapFacetV3` migrates from the legacy `contractIsAllowed` + `selectorIsAllowed` pair to the stricter `contractSelectorIsAllowed`, and `WithdrawablePeriphery` adds a `ZeroAmount` revert plus routes native transfers through `LibAsset.transferAsset`. Approval and native-ETH paths are intentionally out of scope — the Tron USDT issue is `transfer()`-only.
```

(Burrasec reply is structurally identical: `PR/Commit` first, then `Hey @Josip Koncurat. …`, scope, same context paragraph.)

**Step 6** — Helper sends to `dev-sc-audit` (`WEBHOOK_DEV_SC_AUDIT`); exit `0` → success printed. If env var unset → exit `2` → fallback file written for that channel only.

This example calibrates two things you can't get from the abstract rules: the **prose density** of the context paragraph (5–7 sentences of compressed reasoning, not bullet lists) and the **exact template layout** for both auditors.
