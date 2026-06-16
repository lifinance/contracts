---
name: check-open-prs
description: Personal PR inbox for LI.FI engineers — outgoing PRs (yours) and incoming review queue (others'). One dry-run dashboard sourced from a deterministic script, with Slack thread cross-referencing only where the ball-in-whose-court question is open. Use when the user says "check open PRs", "check my open PRs", "PR triage", "what PRs need me", "review queue", "where do my PRs stand", "/check-open-prs", "quick PR check" (quick mode), "refresh the PR dashboard" (refresh mode), or asks for a personal PR dashboard.
usage: /check-open-prs
---

# Check Open PRs

> **Usage**: `/check-open-prs`

All mechanical data collection lives in a deterministic script — **never** loop `gh pr view` / `gh api` / Slack calls per PR yourself. The model's job is only the judgment layer on top: Slack thread state for ambiguous PRs, what needs the user's attention, and suggested next actions.

The script is also directly usable from a terminal for zero tokens:

```bash
bunx tsx script/utils/check-open-prs.ts          # human-readable dashboard
bunx tsx script/utils/check-open-prs.ts --json   # compact JSON (what this skill consumes)
bunx tsx script/utils/check-open-prs.ts --quick  # own PRs only, skips incoming queue
```

GitHub scope is env-overridable (LI.FI defaults baked in), so the script is org-agnostic without code edits:

- `PR_DASH_ORGS` — comma list of owners to search for your own PRs (default `lifinance,lifinance-tron`).
- `PR_DASH_INCOMING_REPOS` — comma list of `owner/repo` whose PRs form your review queue (default `lifinance/contracts,lifinance/contracts-tron`).

## Phase 1 — collect (ONE Bash call)

```bash
bunx tsx script/utils/check-open-prs.ts --json
```

(Add `--quick` for quick mode.) The script returns, per PR: repo/number/title/url, kind (`own`/`incoming`), bucket, draft, CI rollup + failing checks tagged `review/audit` vs `restartable` vs `core-dev-gate`, conflicts, reviewDecision, mergeStateStatus, last commit, last non-author human comment, my last review, and `slackCheck: true` where Slack thread state is needed to finish classification. Archived-repo PRs and stale incoming PRs are already excluded (listed under `excluded`).

**Refresh mode** ("refresh the dashboard"): just re-run the script — it's cheap. Never re-render from data fetched earlier in the conversation; a PR may have been replied to, merged, or re-pinged since. Stamp every dashboard with the script's `asOf` (convert to `+07`).

## Phase 1.5 — Slack cross-reference (ONLY `slackCheck: true` PRs)

Skip this entirely for PRs without the flag. For the flagged set:

1. **Locate threads.** One scrape of `#dev-sc-review` (`C088UJWC8PR`) history (last 6 weeks) serves all contracts-repo PRs — match by PR URL. Fall back to `slack_search_public` (`in:#dev-sc-review pull/<NUMBER>`) only for PRs not in the scraped window. No post found → mark "not posted for review yet".
2. **Read each found thread** with `slack_read_thread` (`response_format="detailed"`), batched 5–8 per message in parallel. Paginate until `reply_count` is exhausted — the missed reply is usually the newest, which decides the bucket.
3. **Classify own PRs mechanically** by last human (non-bot) message author — content never overrides this rule:
   - Last author is the user → **REMIND**: `<48h` since that message → REMIND-RECENTLY-PINGED (cooldown), `≥48h` → REMIND-DUE. Zero replies → apply the 48h rule to the parent post.
   - Last author is anyone else → **YOUR-ACTION**.
4. **Incoming `MAYBE-REREVIEW` PRs** become INBOX-REREVIEW only if the PR author posted an explicit hand-back after the user's review (`ready for re-review | PTAL | addressed | rebased | all comments addressed`, case-insensitive) AND the last human reply isn't the user's. New commits alone are not a signal; a re-ping the user already answered is not a signal.

### Hard invariants

1. **Never estimate a Slack timestamp** — every cooldown figure comes from an actual `Message TS` of the actual last reply.
2. **Search-result context snippets are NOT thread content** — they preview only the FIRST replies and silently omit the newest. Discovery only; every classification needs a `slack_read_thread` from THIS invocation.
3. **One audit line per Slack-classified PR**: `Audit: #1806 last_reply_ts=… (by=me, 0.4h ago) replies=4/4 → RECENTLY-PINGED`. A classification without one is a bug.

## Phase 1.6 — render the dashboard

Header: `As of <YYYY-MM-DD HH:MM +07> — full | quick | refresh`. Sections in order, tables with PR / title / key timestamps / notes:

1. 🔔 **REMIND-DUE** · ⏳ **REMIND-RECENTLY-PINGED** · 👀 **YOUR-ACTION** (from Phase 1.5)
2. 🔴 **CI-RED** (flag review/audit-gated vs restartable failures, from script) · ⚔️ **CONFLICTS** · 🚧 **APPROVED-BLOCKED** (approved + green but `mergeState != CLEAN`; render the script's `note` verbatim) · ✅ **READY-TO-MERGE** (only `mergeState == CLEAN` — actually mergeable now)
3. 📝 **OWN-DRAFTS** (script sub-buckets: READY-TO-FLIP / NEEDS-WORK / DORMANT / SYNC-PR)
4. 🧹 **STALE**
5. 📥 **INCOMING-UNREVIEWED** · 🔁 **INCOMING-REREVIEW**
6. **Excluded** + suppressed counts (`WAITING-ON-OTHERS / WAITING-ON-AUTHOR / DONE-BY-ME: N each`) for auditability.

In quick mode render only group 1–2 and note: "Quick mode — drafts, stale, and incoming queue not scanned."

End with the action menu and **STOP — no actions without explicit approval**:

```text
Proceed?
  (a) Bump REMIND-DUE threads          (e) Open INCOMING-UNREVIEWED for review
  (b) Investigate YOUR-ACTION PRs       (f) Open INCOMING-REREVIEW with diff-since-my-review
  (c) Walk through OWN-DRAFTS           (g) All of the above
  (d) Walk through STALE PRs            (h) Cancel
```

## Phase 2A — bump REMIND-DUE threads

Immediately before posting, re-read each target thread; skip (and say why) if the last message is no longer the user's or is now <48h old. Post one reply per PR via `slack_send_message` with `thread_ts=<parent_ts>` — **exact text, do not paraphrase**:

```text
friendly bump <!subteam^S096X6MCB0C>
```

(The `<!subteam^…>` syntax is mandatory — plain `@smartcontract_core` doesn't notify.) Confirm each post with its permalink.

## Phase 2B/2C — walk OWN-DRAFTS / STALE

Per PR, one short prompt with the script's bucket and suggested next step; execute the chosen disposition:

- Drafts: (1) flip ready (`gh pr ready <n>` + invoke `post-pr-for-review`) (2) keep working (3) close with reason (4) investigate (Phase 3) (5) skip.
- Stale: (1) close with reason (2) post "Still active — target: <D>" (3) re-assign (4) convert to draft (`gh pr ready --undo`) (5) investigate (6) skip.

## Phase 2D — incoming queue

- **INBOX-UNREVIEWED**: show link + 2-line preview; offer open-in-browser / sub-agent triage (≤200 words) / skip.
- **INBOX-REREVIEW**: fetch diff since my last review (`gh pr diff <n> --commit-range <last_review_sha>..HEAD`), quote the dev's hand-back message, list my unresolved inline comments; offer browser / sub-agent verify-comments-addressed / skip.

Never auto-approve, auto-comment, or auto-request-changes — the skill routes; the human reviews.

## Phase 3 — sub-agent investigation (on request)

One sub-agent per PR, in parallel, self-contained prompt: PR URL + pasted Slack thread + "pull review state via `gh pr view --json reviewDecision,reviews,comments,statusCheckRollup,mergeable` + inline comments, identify what the team is blocking on and ONE concrete next step, report <300 words". Consolidate, then offer: implement interactively / in parallel / list only / done.

## Phase 4 — implementation (per-PR approval required)

`gh pr checkout <n>` → apply → lint/test → push → reply in the Slack thread linking the commit. Do **not** invoke `/pr-ready` here (that's the pre-create gate).

## What this skill never does

- Touches closed or merged PRs; auto-reminds on STALE; re-pings inside the 48h cooldown.
- Loops per-PR `gh`/Slack calls when the script (or a batch) covers it.
- Pushes code or submits any review without explicit per-PR approval.
