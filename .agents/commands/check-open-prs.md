---
name: check-open-prs
description: Personal PR dashboard — your outgoing PRs and your incoming review queue — built from a deterministic script plus Slack thread checks where needed. Use for "check open PRs", "review queue", "what PRs need me", "quick PR check" (quick mode), "refresh the PR dashboard" (refresh mode).
usage: /check-open-prs
---

# Check Open PRs

All data collection lives in `script/utils/check-open-prs.ts` — **never** loop `gh pr view` / `gh api` / Slack calls per PR yourself. Your job is the judgment layer: Slack thread state for ambiguous PRs, what needs the user's attention, and next actions.

GitHub scope is env-overridable (LI.FI defaults baked in):

- `PR_DASH_ORGS` — owners searched for your own PRs (default `lifinance,lifinance-tron`).
- `PR_DASH_INCOMING_REPOS` — `owner/repo` list forming your review queue (default `lifinance/contracts,lifinance/contracts-tron`).

## Phase 1 — collect (one Bash call)

```bash
bunx tsx script/utils/check-open-prs.ts --json          # add --quick for quick mode
```

Per PR the script returns: `repo`/`n`/`title`/`url`, `kind` (`own`/`incoming`), `bucket`, `draft`, `ci` + `ciFail` (failing checks tagged `review/audit` / `restartable` / `human-gate`), `conflicts`, `decision` (review decision), `mergeStateStatus`, `lastCommit`, `lastNonAuthor` (last non-author human comment), `myReview: {state, at, sha}` (`sha` = commit my review was against, used in Phase 2D), and `slackCheck: true` where Slack state is needed to finish classification. Archived-repo and stale incoming PRs are already excluded (listed under `excluded`).

**Refresh mode**: re-run the script — never re-render from data fetched earlier in the conversation. Stamp every dashboard with the script's `asOf` (converted to `+07`).

### Bucket mapping

Each PR gets one native `bucket`. Rows with `slackCheck: true` are provisional until Phase 1.5; if Phase 1.5 is skipped, they render under their raw bucket name.

| Script native bucket                                     | Needs Phase 1.5 (Slack)?       | Display section                                             |
| -------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------- |
| `WAITING-ON-TEAM`                                        | yes — 48h cooldown split       | 🔔 REMIND-DUE (`≥48h`) / ⏳ REMIND-RECENTLY-PINGED (`<48h`) |
| `WAITING-ON-ME`                                          | yes — confirm ball-in-court    | 👀 YOUR-ACTION                                              |
| `CI-RED`                                                 | no                             | 🔴 CI-RED                                                   |
| `CONFLICTS`                                              | no                             | ⚔️ CONFLICTS                                                |
| `APPROVED-BLOCKED`                                       | no                             | 🚧 APPROVED-BLOCKED                                         |
| `READY-TO-MERGE`                                         | no                             | ✅ READY-TO-MERGE                                           |
| `OWN-DRAFT/{READY-TO-FLIP,NEEDS-WORK,DORMANT,SYNC-PR}`   | no                             | 📝 OWN-DRAFTS                                               |
| `STALE`                                                  | no                             | 🧹 STALE                                                    |
| `INBOX-UNREVIEWED`                                       | no                             | 📥 INCOMING-UNREVIEWED                                      |
| `MAYBE-REREVIEW`                                         | yes — confirm author hand-back | 🔁 INCOMING-REREVIEW (else suppressed)                      |
| `WAITING-ON-AUTHOR` / `WAITING-ON-OTHERS` / `DONE-BY-ME` | no                             | suppressed counts (group 6)                                 |

`--quick` omits the incoming queue at the source; render only display groups 1–2.

## Phase 1.5 — Slack cross-reference (only `slackCheck: true` PRs)

1. **Locate threads.** One scrape of `#dev-sc-review` (`C088UJWC8PR`) history (last 6 weeks), matched by PR URL. Fall back to `slack_search_public` (`in:#dev-sc-review pull/<NUMBER>`) for PRs the scrape did not match. Assert "not posted for review yet" only when the PR's `created` is inside the scrape window **and** the fallback search returned nothing — otherwise emit no Slack note. Never write "Posted today": say "Created today" for a fresh PR; "posted" means a confirmed `#dev-sc-review` message.
2. **Read each thread** with `slack_read_thread` (`response_format="detailed"`), 5–8 in parallel per message. Paginate until `reply_count` is exhausted — the missed reply is usually the newest, which decides the bucket.
3. **Own PRs** — classify by the last human (non-bot) message author; content never overrides this:
   - The user → REMIND: `<48h` since that message → REMIND-RECENTLY-PINGED, `≥48h` → REMIND-DUE. Zero replies → apply the 48h rule to the parent post.
   - Anyone else → YOUR-ACTION.
4. **Incoming `MAYBE-REREVIEW`** → INCOMING-REREVIEW only if the PR author posted an explicit hand-back after the user's review (`ready for re-review | PTAL | addressed | rebased | all comments addressed`, case-insensitive) AND the last human reply isn't the user's. New commits alone, or a re-ping the user already answered, are not signals.

### Hard invariants

1. Never estimate a Slack timestamp — every cooldown comes from the actual `Message TS` of the actual last reply.
2. Search-result snippets are not thread content — they show only the first replies. Every classification needs a `slack_read_thread` from this invocation.
3. Print one audit line per Slack-classified PR, immediately above the dashboard:
   `Audit: #<pr> last_reply_ts=<ISO Message TS> (by=<me|login>, <Δh> ago) replies=<read>/<reply_count> → <DISPLAY-BUCKET>`.
   Every field traces to this invocation's `slack_read_thread`; `read` must equal `reply_count`. A Slack-classified PR without its audit line, or with `read < reply_count`, is a bug.

## Phase 1.6 — render the dashboard

Header: `As of <YYYY-MM-DD HH:MM +07> — full | quick | refresh`. Sections in order, tables with PR / title / key timestamps / notes:

1. 🔔 REMIND-DUE · ⏳ REMIND-RECENTLY-PINGED · 👀 YOUR-ACTION
2. 🔴 CI-RED (flag review/audit-gated vs restartable) · ⚔️ CONFLICTS · 🚧 APPROVED-BLOCKED (approved + green but `mergeStateStatus != CLEAN`; render the script's `note` verbatim) · ✅ READY-TO-MERGE (only `mergeStateStatus == CLEAN`)
3. 📝 OWN-DRAFTS (READY-TO-FLIP / NEEDS-WORK / DORMANT / SYNC-PR)
4. 🧹 STALE
5. 📥 INCOMING-UNREVIEWED · 🔁 INCOMING-REREVIEW
6. Excluded + suppressed counts (`WAITING-ON-OTHERS / WAITING-ON-AUTHOR / DONE-BY-ME: N each`) as a plain list, never a table.

Close each table with a blank line before the next heading — otherwise the next separator is swallowed and the table header bleeds into the next section.

Quick mode: render groups 1–2 and note "Quick mode — drafts, stale, and incoming queue not scanned."

End with the menu and **stop — no action without explicit approval**:

```text
Proceed?
  (a) Bump REMIND-DUE threads          (e) Open INCOMING-UNREVIEWED for review
  (b) Investigate YOUR-ACTION PRs       (f) Open INCOMING-REREVIEW with diff-since-my-review
  (c) Walk through OWN-DRAFTS           (g) All of the above
  (d) Walk through STALE PRs            (h) Cancel
```

## Phase 2A — bump REMIND-DUE threads

Immediately before posting, re-read each thread; skip (and say why) if the last message is no longer the user's or is now <48h old. Post one reply per PR via `slack_send_message` with `thread_ts=<parent_ts>`, exact text:

```text
friendly bump <!subteam^S096X6MCB0C>
```

`S096X6MCB0C` is the `@smartcontract_core` subteam; plain `@smartcontract_core` doesn't notify. Confirm each post with its permalink. Never bump STALE PRs or re-ping inside the 48h cooldown.

## Phase 2B/2C — walk OWN-DRAFTS / STALE

Per PR, one short prompt with the bucket and suggested next step; execute the chosen disposition:

- Drafts: (1) flip ready (`gh pr ready <n> --repo <owner>/<repo>` + `post-pr-for-review`) (2) keep working (3) close with reason (4) investigate (Phase 3) (5) skip.
- Stale: (1) close with reason (2) post "Still active — target: <D>" (3) re-assign (4) convert to draft (`gh pr ready <n> --repo <owner>/<repo> --undo`) (5) investigate (6) skip.

## Phase 2D — incoming queue

- **INCOMING-UNREVIEWED**: link + 2-line preview; offer open-in-browser / sub-agent triage (≤200 words) / skip.
- **INCOMING-REREVIEW**: diff since my last review — `gh pr diff` has no range flag, so use `gh api -H 'Accept: application/vnd.github.diff' repos/<owner>/<repo>/compare/<sha>...<head>` with `<sha>` = `myReview.sha` and `<head>` from `gh pr view <n> --repo <owner>/<repo> --json headRefOid -q .headRefOid`. If `myReview.sha` is `null` or the compare fails (force-push dropped it), fall back to the full `gh pr diff <n> --repo <owner>/<repo>`. Quote the hand-back message, list my unresolved inline comments; offer browser / sub-agent verify-comments-addressed / skip.

Never auto-approve, auto-comment, or auto-request-changes — the skill routes; the human reviews.

## Phase 3 — sub-agent investigation (on request)

One sub-agent per PR, in parallel, self-contained prompt: PR URL + pasted Slack thread + "pull review state via `gh pr view --json reviewDecision,reviews,comments,statusCheckRollup,mergeable` + inline comments, identify what the team is blocking on and ONE concrete next step, report <300 words". Consolidate, then offer: implement interactively / in parallel / list only / done.

## Phase 4 — implementation (per-PR approval required)

`gh pr checkout <n> --repo <owner>/<repo>` → apply → lint/test → push → reply in the Slack thread linking the commit. Never touch closed or merged PRs.
