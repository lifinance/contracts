---
name: request-audit
description: Prepare and send a smart contract audit request to Slack (Sujith or burrasec team)
usage: /request-audit <PR_NUMBER_OR_URL> [--urgent]
---

# Audit Request Command

> **Usage**: `/request-audit <PR_NUMBER_OR_URL> [--urgent]`
>
> Examples:
> - `/request-audit 1715`
> - `/request-audit https://github.com/lifinance/contracts/pull/1715`
> - `/request-audit 1715 --urgent`

## Purpose

Fetch a PR, extract its scope and context, draft an audit request (parent post + thread reply), let the user choose the channel(s) and optionally edit the message, then post to Slack only after explicit confirmation.

**CRITICAL**: Never post to Slack without the user explicitly confirming at Step 4.

---

## Channels

| Alias | Channel | Slack ID | Auditors | API mention | Display name (manual) | Greeting |
|---|---|---|---|---|---|---|
| **sujith** | `#lifi-external-sujith` | `C08CJ4FEHQA` | Sujith Somraaj | `<@U05GN6XH57T>` | `@Sujith Somraaj` | `Hey @Sujith Somraaj!` |
| **burrasec** | `#lifi-external-burrasec` | `C094C46JSDP` | Josip | `<@U094M720QDP>` | `@Josip Vuković` | `Hey @Josip Vuković.` |

> **⚠️ Slack Connect limitation**: Both audit channels are Slack Connect (externally shared) channels — they cross a workspace boundary into the auditor's Slack org. Slack's API blocks bots from posting to these channels at the server level, regardless of OAuth scopes. This is a deliberate Slack security policy to prevent automated tools from sending data to external parties without a human explicitly acting. **The `slack_send_message` tool will always fail for these channels.** When posting fails with `mcp_externally_shared_channel_restricted`, skip to Step 6b.

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

**The PR body is the authoritative source for what this PR actually does.** Read it carefully before
writing any context. A PR may be part of a multi-PR effort (e.g. "this PR adds the foundation; the
Tron-specific fix is in a separate fork PR") — the context must only describe what is in *this* PR,
not what is in a related PR. The Slack thread may discuss the broader problem or motivation, but never
let it override or expand what the PR body says is in scope.

Extract from:
1. The "Summary" or "What's in this PR" section of the PR body — 2–5 sentences, technical but concise
2. The "Why" / motivation section for root cause explanation
3. Any explicit "NOT in this PR" or "Explicitly excluded" sections — these are as important as inclusions
4. **Merge order / multi-PR sequencing**: Look for "Merge order", "Related PRs", or any section that describes a sequence of PRs. If this PR is step N of M in a multi-part effort, surface that explicitly — auditors need to know that a follow-up audit will be needed for a subsequent PR (e.g. "This is step 1 of 2; a second audit will follow for the contracts-tron fork where LibAsset gets the actual bypass."). This is critical context that scopes what they are and are not being asked to review.
5. Trim to the essential technical reason, drop implementation trivia

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
- `scope_summary` = the most prominent contract + version wrapped in backticks, e.g. `` `GenericSwapFacetV3 v2.0.0` ``.
  If there are 2–3 contracts total: list them all, each in backticks, comma-separated.
  If there are 4+ contracts: use the first one in backticks + ` + N more`, e.g. `` `GenericSwapFacetV3 v2.0.0` + 6 more ``.
- `urgency_suffix` = ` (urgent)` if urgent, else empty.

Examples:
```
Audit: `DeBridgeDlnFacet v1.1.0` :thread:
Audit: `PolymerCCTPFacet v2.0.1` :thread:
Audit: `GenericSwapFacetV3 v2.0.0` + 6 more :thread:
Audit: `Patcher v1.0.1` (urgent) :thread:
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
- `full_scope_list`: comma-separated list of ALL contract names with versions, each wrapped in backticks — e.g. `` `GenericSwapFacetV3 v2.0.0`, `WithdrawablePeriphery v2.0.0` ``
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

**Code style**: Wrap in backticks every function name, variable name, contract name, repo name, error name, constant, selector, and version string — e.g. `transfer()`, `safeTransfer`, `LibAsset.transferERC20`, `LibAsset.sol`, `contracts-tron`, `TransferFailed`, `contractSelectorIsAllowed`, `v2.1.3`. Plain prose words (the, this, PR, etc.) are never wrapped.

> **File output exception**: Slack does not reliably render backtick inline code when content is pasted from an external file — it renders when typed directly in the composer or posted via API, but shows literal backticks when pasted. The `/tmp/audit-request-{pr}.md` file must therefore use **plain text** (no backticks). Code style only applies to API-posted messages.

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
- `full_scope_list`: same as Sujith — each contract+version in backticks, comma-separated
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

### Option 1: Sujith (#lifi-external-sujith)

**Parent message:**
```
{parent_message}
```

**Thread reply:**
```
{thread_reply_sujith}
```

---

### Option 2: Burrasec (#lifi-external-burrasec)

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

For each chosen channel, in sequence:

1. **Post the parent message** to the channel using `slack_send_message`:
   - `channel_id`: the channel's Slack ID
   - `message`: the parent message text
   - Capture the returned message timestamp (`ts`) — needed for the thread

2. **Post the thread reply** as a reply to the parent:
   - `channel_id`: same channel ID
   - `message`: the thread reply text
   - `thread_ts`: the `ts` from step 1 above

3. After both posts, output:

```
✅ Sent to {channel_name}:
   Parent: {slack_message_link}
   Thread: {slack_thread_link}
```

If posting fails at any step, report the error immediately and ask the user how to proceed — do NOT retry silently.

### Step 6b — Manual fallback (Slack Connect channels)

If `slack_send_message` fails with `mcp_externally_shared_channel_restricted`:

1. Use **display name mentions** (e.g. `@Sujith Somraaj`) instead of API mentions (e.g. `<@U05GN6XH57T>`) — API mention syntax is only resolved by the Slack API, not when typed/pasted manually.

2. Write **all chosen channels** to `/tmp/audit-request-{pr_number}.md` in a **single write** — never write one channel then overwrite with the second. Build the full file content first, then write once. Format:

```markdown
# Audit Request — PR #{pr_number}

## #lifi-external-{channel_1}

### Parent message
Post this as a new message in the channel:

---
{parent message — channel 1 — display name mentions — plain text, no backticks}
---

### Thread reply
Reply to the parent message with this (click the reply icon on the parent):

---
{thread reply — channel 1 — display name mentions — plain text, no backticks}
---

## #lifi-external-{channel_2}   ← include only if both channels selected

### Parent message
Post this as a new message in the channel:

---
{parent message — channel 2 — display name mentions — plain text, no backticks}
---

### Thread reply
Reply to the parent message with this (click the reply icon on the parent):

---
{thread reply — channel 2 — display name mentions — plain text, no backticks}
---
```

3. Tell the user the file path so they can open it:

```
⚠️ Cannot post automatically — Slack Connect channels block API bots (security policy).
Messages written to /tmp/audit-request-{pr_number}.md — open it and copy each block.
```

---

## Error Handling

| Situation | Action |
|---|---|
| PR not found | Report error and stop |
| PR has no commits | Try separate `gh pr view --json commits`; if still empty, ask user for commit hash |
| Scope cannot be determined | List changed `src/` files and ask user to confirm scope before continuing |
| Slack post fails with `mcp_externally_shared_channel_restricted` | Expected for Slack Connect channels — go to Step 6b and output copy-paste-ready blocks |
| Slack post fails with any other error | Report error, do NOT silently retry, ask user |
| User types something other than 1–4 | Ask again |

---

## Quality Checklist

Before posting, verify all of these:

- [ ] Step 1b was asked — user was given the chance to provide a Slack thread or extra context
- [ ] If a Slack thread URL was provided, it was read and synthesized (not just linked)
- [ ] Latest commit OID is the last entry in the `commits` array (not the first)
- [ ] Commit URL is `{pr_url}/commits/{oid}` — verify format
- [ ] Scope lists at least one contract name with version
- [ ] Both messages mention the auditor by Slack `<@USERID>` mention (not just their name)
- [ ] Context is 3–7 sentences of prose, not a wall of text, not a bullet list
- [ ] Context leads with root cause, not implementation details
- [ ] Context accurately reflects only what **this PR** does — not a related PR, fork, or follow-up
- [ ] If PR body has an explicit "NOT in this PR" section, its exclusions are reflected in the context
- [ ] If PR body has a "Merge order" or sequencing section, the audit sequence (step N of M, follow-up audit needed) is reflected in the context
- [ ] `--urgent` or urgency signals reflected in both the parent title and the greeting
- [ ] User has explicitly confirmed at Step 4 before any `slack_send_message` call
- [ ] Thread reply is posted as a thread (`thread_ts` set) not as a separate top-level message

---

## Example Run — PR #1715

**Input**: `/request-audit 1715`

**PR data extracted**:
```bash
gh pr view 1715 --repo lifinance/contracts --json number,title,body,url,commits,files,labels,state
```

**Latest commit OID** (last in array): `142d9d809e8184fff4a21605fcd41983ed2e0e4d`

**Scope** (from PR title brackets):
```
GenericSwapFacetV3 v2.0.0, WithdrawablePeriphery v2.0.0, LiFiDEXAggregator v1.13.0,
ReceiverAcrossV3 v1.2.0, ReceiverChainflip v1.1.0, ReceiverStargateV2 v1.2.0, TokenWrapper v1.3.0
```

**Step 1b — user provides Slack thread**:
```
User: https://lifi-protocol.slack.com/archives/C088UJW2DPZ/p1776070807528139
```

Parse URL → `channel_id: C088UJW2DPZ`, `message_ts: 1776070807.528139`

Read thread with `slack_read_thread`. Key points extracted:
- Tron USDT's `transfer()` is declared `returns (bool)` but never actually returns — the EVM returns 32 zero bytes, which Solady's `safeTransfer` interprets as `false` and reverts.
- Alternatives discussed: a `SafeTransferLibWrapper`, a LibAsset chain-id gate, a permanent open PR. A `contracts-tron` fork was chosen to keep the main codebase clean (no Tron logic deployed on 60+ other chains).
- The Slack thread discusses the Tron bypass, but the PR body explicitly states that the bypass itself lives in the separate `contracts-tron` fork PR — this PR contains **no Tron-specific code**.

**Merged context** — PR body is ground truth for scope; Slack thread provides the "why"; Merge order section surfaces the two-step audit sequence:
```
Tron's canonical USDT contract declares transfer() as returns (bool) but omits the return
statement — the EVM returns 32 zero bytes, which Solady's safeTransfer treats as false
and reverts. Rather than adding Tron-specific bytecode to 60+ EVM chains, the team decided
to maintain a contracts-tron fork where the actual bypass lives inside LibAsset.transferERC20.
This PR is step 1 of a two-part audit sequence: it routes every periphery ERC20 transfer
through LibAsset so that the single fork-level change covers all call sites automatically —
LibAsset.sol is not modified here (stays at v2.1.3). Once this PR is audited and merged, a
second audit will follow for the contracts-tron fork PR where LibAsset receives the Tron USDT
bypass. GenericSwapFacetV3 is also migrated from the legacy contractIsAllowed+selectorIsAllowed
pair to the stricter contractSelectorIsAllowed (granular contract+selector whitelist).
```

**Parent message**:
```
Audit: `GenericSwapFacetV3 v2.0.0` + 6 more :thread:
```

**Thread reply (Sujith)**:
```
Hey <@U05GN6XH57T>! I have a new audit for you.

PR: https://github.com/lifinance/contracts/pull/1715
Commit: https://github.com/lifinance/contracts/pull/1715/commits/142d9d809e8184fff4a21605fcd41983ed2e0e4d

Scope: `GenericSwapFacetV3 v2.0.0`, `WithdrawablePeriphery v2.0.0`, `LiFiDEXAggregator v1.13.0`, `ReceiverAcrossV3 v1.2.0`, `ReceiverChainflip v1.1.0`, `ReceiverStargateV2 v1.2.0`, `TokenWrapper v1.3.0`

Tron's canonical USDT contract declares transfer() as returns (bool) but omits the return statement — the EVM returns 32 zero bytes, which Solady's safeTransfer treats as false and reverts. Rather than adding Tron-specific bytecode to 60+ EVM chains, the team decided to maintain a contracts-tron fork where the actual bypass lives inside LibAsset.transferERC20. This PR is step 1 of a two-part audit sequence: it routes every periphery ERC20 transfer through LibAsset so that the single fork-level change covers all call sites automatically — LibAsset.sol is not modified here (stays at v2.1.3). Once this PR is audited and merged, a second audit will follow for the contracts-tron fork PR where LibAsset receives the Tron USDT bypass. GenericSwapFacetV3 is also migrated from the legacy contractIsAllowed+selectorIsAllowed pair to the stricter contractSelectorIsAllowed (granular contract+selector whitelist).
```

**Thread reply (Burrasec)**:
```
PR: https://github.com/lifinance/contracts/pull/1715
Commit: https://github.com/lifinance/contracts/pull/1715/commits/142d9d809e8184fff4a21605fcd41983ed2e0e4d

Hey @Josip Vuković. I have a new audit for you.

Scope: `GenericSwapFacetV3 v2.0.0`, `WithdrawablePeriphery v2.0.0`, `LiFiDEXAggregator v1.13.0`, `ReceiverAcrossV3 v1.2.0`, `ReceiverChainflip v1.1.0`, `ReceiverStargateV2 v1.2.0`, `TokenWrapper v1.3.0`

Tron's canonical USDT contract declares transfer() as returns (bool) but omits the return statement — the EVM returns 32 zero bytes, which Solady's safeTransfer treats as false and reverts. Rather than adding Tron-specific bytecode to 60+ EVM chains, the team decided to maintain a contracts-tron fork where the actual bypass lives inside LibAsset.transferERC20. This PR is step 1 of a two-part audit sequence: it routes every periphery ERC20 transfer through LibAsset so that the single fork-level change covers all call sites automatically — LibAsset.sol is not modified here (stays at v2.1.3). Once this PR is audited and merged, a second audit will follow for the contracts-tron fork PR where LibAsset receives the Tron USDT bypass. GenericSwapFacetV3 is also migrated from the legacy contractIsAllowed+selectorIsAllowed pair to the stricter contractSelectorIsAllowed (granular contract+selector whitelist).
```
