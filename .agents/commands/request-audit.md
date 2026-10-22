---
name: request-audit
description: Prepares and sends a smart contract audit request to Slack (Sujith or burrasec team); use when a PR is ready for external audit review.
usage: /request-audit <PR_NUMBER_OR_URL> [--urgent]
---

# Audit Request Command

> **Usage**: `/request-audit <PR_NUMBER_OR_URL> [--urgent]`

Draft an audit request (parent post + thread reply) from the PR, post to the chosen channel(s)
only after explicit confirmation, then move the linked Linear ticket to **In Audit**.

## Channels

| Alias | Channel | Mention ID | Display name (manual fallback) | Greeting position |
|---|---|---|---|---|
| **sujith** | `#dev-sc-audit` | `<@U05GN6XH57T>` | `@Sujith Somraaj` | greeting **before** PR/Commit |
| **burrasec** | `#dev-sc-audit-burrasec` | `<@U094M720QDP>` | `@Josip Koncurat` | PR/Commit **before** greeting |

Channel `#X` posts via env var `WEBHOOK_X` (uppercase, hyphens → underscores):
`WEBHOOK_DEV_SC_AUDIT`, `WEBHOOK_DEV_SC_AUDIT_BURRASEC`. URLs live in 1Password vault
**Developers Smart Contract**, item **Webhooks SC Channels**. An unset var means a manual
fallback for that channel (Step 5, exit 2).

## Step 1 — Fetch PR data

```bash
gh pr view <PR_NUMBER> --repo lifinance/contracts \
  --json number,title,body,url,headRefName,commits,files,labels,state
```

`latest_commit_oid` is the **last** `commits[].oid` (re-run with `--json commits` if the array
came back empty). If the PR isn't found, report and stop.

### 1a — Linked Linear ticket

PRs are usually linked to an **EXSC** ticket (`https://linear.app/lifi-linear/team/EXSC/all`),
whose description is high-value audit context. Find `EXSC-\d+` in, in order: PR body (token or
`linear.app/lifi-linear/issue/EXSC-\d+/…` URL), PR title, `headRefName` (e.g.
`feat/exsc-1234-…`, case-insensitive). Fetch with `mcp__linear__get_issue` and use description
and comments for the context paragraph. If none is found, skip silently — don't ask.

### 1b — Slack context, only if free (never block)

Read a Slack thread only if the Linear ticket links one or the user passed a URL/note; otherwise
draft from PR + Linear. Don't ask for a thread. URL → `slack_read_thread` args:

```text
https://lifi-protocol.slack.com/archives/{channel_id}/p{ts_without_dot}
→ message_ts: insert dot after 10th digit, e.g. p1776070807528139 → 1776070807.528139
```

## Step 2 — Scope, context, urgency

**Scope** (contracts + versions), first match wins; prefer 1–3 over 4:

1. PR title brackets, e.g. `[GenericSwapFacetV3 v2.0.0, WithdrawablePeriphery v2.0.0, …]`
2. PR body table `| Contract | Version | … |`
3. PR body `Scope:` line
4. Distinct `.sol` filenames from `files[]` under `src/Facets|Periphery|Helpers|Libraries|Security/`

If scope can't be determined, list the changed `src/` files and ask the user to confirm.

**Context** from the PR body: summary (2–5 sentences, no implementation trivia), motivation,
**NOT in this PR** exclusions, and merge order if step N of M.

**Urgent** if any: `--urgent`; PR title/body/labels mention "urgent" / "time pressure" /
"blocker" / "ASAP" / "today" or carry an urgency label; Linear `priority: 1`; Linear `dueDate`
within ~3 days.

## Step 3 — Build the messages

### Parent (channel post)

```text
Audit: {scope_summary} {urgency_suffix} :thread:
```

- `scope_summary` — plain text, no backticks; 2–3 contracts comma-separated, 4+ as
  `{first} + N more` (e.g. `GenericSwapFacetV3 v2.0.0 + 6 more`).
- `urgency_suffix` — `(urgent)`, else omit.

### Thread reply

**Sujith** (greeting first):

```text
Hey <@U05GN6XH57T>! {greeting_line}

PR: {pr_url}
Commit: {pr_url}/commits/{latest_commit_oid}

Scope: {full_scope_list}

{context}
```

**Burrasec** (PR/Commit first):

```text
PR: {pr_url}
Commit: {pr_url}/commits/{latest_commit_oid}

Hey <@U094M720QDP>. {greeting_line}

Scope: {full_scope_list}

{context}
```

- `greeting_line` — natural variation ("I have a new audit for you."). If urgent, append "It's
  a bit urgent — are you able to review this today?"
- `full_scope_list` — every contract with its version, comma-separated.

### Context paragraph

The PR body defines *what* is in scope; Linear and Slack explain *why* and must never expand the
scope beyond the PR body. One prose paragraph (not bullets), 3–7 sentences: root cause/problem
(Linear/Slack if available, else PR summary); what the PR does and explicitly doesn't include
(reflect any "NOT in this PR" section); key design decisions only if relevant; urgency/deadline.
From long discussions keep only decision-relevant parts.

**Code style** (webhook posts only; the manual fallback is plain text): backtick every function,
variable, contract, repo, error, constant, selector, and version string — `transfer()`,
`LibAsset.transferERC20`, `LibAsset.sol`, `contracts-tron`, `TransferFailed`, `v2.1.3`. Never
wrap plain prose words.

## Step 4 — Preview and confirm

Show a preview: PR number + title (truncated to 80 chars), commit OID, Urgent yes/no, Linear
(`EXSC-1234 → In Audit on send`, or "none linked"), then for each channel the parent message and
thread reply in code blocks. Then ask:

```text
Where should I send this?
  1 — Sujith only
  2 — Burrasec only
  3 — Both channels
  4 — Cancel

Reply 1/2/3/4, or suggest edits to the message text before I send.
```

Stop and wait. `1`–`3` → Step 5. `4` → stop: send nothing, skip Step 6. Anything else that is not an edit request → ask again. If edits
are requested, apply them, show the updated message, and confirm
(`Ready to send? (yes / cancel)`) before sending.

## Step 5 — Send

Per chosen channel, independently (one failure must not abort the other):

1. Combine parent + blank line + thread reply into one message, dropping `:thread:` (webhooks
   can't thread). Use the code style.
2. Write it to `/tmp/audit-{pr_number}-{channel}.txt` (multi-line text mustn't be shell-quoted).
3. Run, with `{channel}` = `dev-sc-audit` or `dev-sc-audit-burrasec`:

   ```bash
   bunx tsx script/utils/send-slack-webhook-message.ts \
     --channel {channel} \
     --message-file /tmp/audit-{pr_number}-{channel}.txt
   ```

| Exit | Meaning | Action |
|---|---|---|
| `0` | sent | `✅ Sent to #{channel}` |
| `2` | `WEBHOOK_*` env var not set for that channel | Manual fallback for **this channel only** |
| `1` | Slack / network error | Report stderr; do not retry, do not write the fallback |

### Exit 2 — manual fallback

Use display-name mentions instead of `<@…>` (pasted API mentions don't resolve) and plain text
(Slack doesn't render inline code from pasted content). Build the content for all fallback
channels first (omit any that posted), then write once to `/tmp/audit-request-{pr_number}.md` —
never write one channel then overwrite with another:

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

Tell the user, one line per fallback channel, naming the exact missing var:

```text
⚠️ {webhook_var} is not set in .env — wrote manual fallback for #{channel} to
   /tmp/audit-request-{pr_number}.md. Set the env var (URL in 1Password -> Developers
   Smart Contract -> Webhooks SC Channels) to post automatically next time.
```

## Step 6 — Move the Linear ticket to "In Audit"

Only if Step 1a found a ticket.

- At least one channel exited `0` → `mcp__linear__save_issue id = EXSC-1234 state = "In Audit"`
  (Linear resolves the state by name); report `✅ Moved EXSC-1234 to In Audit`.
- Ticket already in `In Audit` or later (`In Review`, `Done`, completed/canceled) → leave it;
  never move a ticket backward.
- No channel exited `0` → don't move it; add
  `↪️ Move EXSC-1234 to In Audit once you've posted the message manually.`

If `save_issue` fails, report it and tell the user to move the ticket by hand — the Slack post
already succeeded, so don't retry in a loop or treat it as fatal.
