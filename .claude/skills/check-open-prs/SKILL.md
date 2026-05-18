---
name: check-open-prs
description: Personal PR inbox for LI.FI engineers — covers both outgoing PRs (yours) and incoming review queue (others'). Produces a single dry-run dashboard with (a) your OWN open PRs cross-referenced with their #dev-sc-review / #dev-backend-expansion-review Slack threads, split into REMIND-team / YOUR-ACTION / OWN-DRAFTS / STALE, and (b) OTHER developers' PRs posted in those channels that need your attention — unreviewed (potential pick up) or you-reviewed-and-dev-addressed (potential re-review). Always dry-run first with explicit approval gates before any Slack post or code change. Optional parallel sub-agent investigation per PR. Use when the user says "check open PRs", "check my open PRs", "PR triage", "what PRs need me", "review queue", "where do my PRs stand", "/check-open-PRs", or asks for a personal PR dashboard.
---

# Check Open PRs

A personal PR inbox: triage your own open PRs (where you're waiting on the team vs the team's waiting on you) and the team's open PRs in the review channels (where you can pick up an unreviewed one, or re-review one you already commented on). Always dry-run first; act only on explicit approval.

## Inputs (defaults)

- **Author** — current `gh` user (`gh api user --jq '.login'`).
- **Lookback** — none for your own PRs (all open ones, regardless of age). 6 weeks of channel history for the incoming-review queue.
- **State** — `open`. Drafts go into their own bucket, not "excluded".
- **Stale threshold** — created ≥6 weeks ago AND last activity ≥2 weeks ago. Stale PRs get a separate disposition section.
- **Reminder cooldown** — 48 hours since your last message in a thread. Under that, the PR is "recently pinged" and skipped from auto-bumps.

## Hard invariants

Violations are bugs — stop, fix, re-run.

1. **Never estimate a Slack timestamp.** Every cooldown / "hours ago" figure must come from an actual `Message TS` on the actual last reply by the current user. Threads routinely have multi-day-later follow-ups ("ready for re-review" two days after the parent), so parent-post ts is not a substitute.
2. **Always read threads with `response_format="detailed"`.** Concise format strips per-reply timestamps. If a fetch came back concise, re-fetch before classifying.
3. **Scan every reply.** Find the most recent message by the current user (for cooldown) and the most recent message overall (for REMIND vs YOUR-ACTION classification). Don't infer from `reply_count` or assume reply 1 is the only one.

Surface a one-line audit at the end of Phase 1 with the exact `Message TS` used per PR, so the user can spot-check:

```text
Audit: #1806 cooldown ts=1779065876.814329 (2026-05-18 07:57:56 +07, 0.4h ago) → RECENTLY-PINGED
```

## Phase 1 — Dry-run (read-only)

### 1.1 Pull open PRs

```bash
gh search prs --author=@me --state=open --limit 200 \
  --json url,title,number,repository,createdAt,updatedAt,isDraft
```

No `--created` filter — pull ALL open PRs (keeping a clean slate is part of the job).

**Drop archived-repo PRs.** `gh search prs` returns PRs in archived repositories; those can't be merged or acted on. For each unique `repository.nameWithOwner`, check once:

```bash
gh api repos/<owner>/<repo> --jq '.archived'
```

Cache per-repo (one call per repo). Add the dropped count to the Excluded section as `Archived repo: N (repos: …)` so the scan stays auditable.

**Split by age:**

- **Active** — `createdAt` within last 6w OR `updatedAt` within last 2w. Goes through the REMIND / YOUR-ACTION / OWN-DRAFTS flow.
- **Stale** — `createdAt` ≥6w ago AND `updatedAt` ≥2w ago. Goes to its own STALE bucket for human disposition.

**Route to a Slack channel by repo:**

- `lifinance/contracts`, `lifinance/contracts-tron` → `#dev-sc-review` (`C088UJWC8PR`).
- `lifinance/lifi-backend`, `lifinance/tenderly-sim`, other backend services → `#dev-backend-expansion-review` (resolve via `slack_search_channels`).
- Other repos (`lifi-claude-plugins`, `lifi-team-skills`, …) → no channel; mark "no review thread expected".

### 1.2 Classify your own non-draft PRs (REMIND / YOUR-ACTION)

For each non-draft, non-stale active PR:

1. **Find the Slack post.** Search the routed channel:
   ```text
   in:#<channel> pull/<NUMBER> from:<@<current-user-slack-id>>
   ```
   If no result, mark "not posted for review yet" and surface in the dashboard so the user can decide whether to post.

2. **Read the thread** (`response_format="detailed"`). Walk every reply.
   - Last author is the current user → **REMIND**. Compute `hours_since = (now - your_last_ts) / 3600`.
     - `<48h` → **REMIND-RECENTLY-PINGED** (skip Phase 2A; spam guard).
     - `≥48h` → **REMIND-DUE** (eligible for Phase 2A).
   - Last author is anyone else → **YOUR-ACTION**.
   - Zero replies → **REMIND**, applying the 48h rule to the parent post ts.

3. **Edge cases:**
   - A re-ping by the user counts as the user's last message; the 48h cooldown resets from there.
   - A bot/Linear/automation reply doesn't count — fall back to the previous human message.

### 1.3 Classify your own draft PRs (OWN-DRAFTS)

Drafts aren't posted for review, but they're still work-in-progress that you owe yourself. Don't dump them into "Excluded".

For each active draft (stale drafts roll into STALE):

```bash
gh api repos/<owner>/<repo>/pulls/<n>/commits --jq '.[-1].commit.committer.date'
gh pr view <n> --json statusCheckRollup
```

Classify into a likely-disposition bucket:

- **READY-TO-FLIP** — CI green, last commit <2w, looks complete → suggest "mark Ready for Review + run `/post-pr-for-review`".
- **NEEDS-WORK** — CI failing, or title tagged `(WIP)` → suggest "finish the WIP".
- **DORMANT** — last commit ≥4w ago → suggest "decide: resume / convert to issue / close".
- **SYNC-PR** — title matches `chore(claude): sync …` or `chore(skills): sync …` (auto-sync output) → suggest "check if the sync target has since been re-synced (PR may be obsolete) or merge".

### 1.4 Classify others' PRs in the review channel (incoming inbox)

This is the team-inbox half. Scan the same channel(s) for PRs **not posted by the current user**.

1. List PR-post messages in `#dev-sc-review` from the last 6 weeks (paginate as needed). Each post follows the `<URL> << <title>` convention. Extract `(owner, repo, pr_number, parent_ts, posted_at, slack_author)`.
2. Drop entries where `slack_author == current_user` (already covered in 1.2).
3. For each remaining PR, fetch state in parallel:
   ```bash
   gh pr view <n> --repo <owner>/<repo> --json \
     author,state,isDraft,reviewDecision,reviews,latestReviews,commits,updatedAt,mergeable
   ```
   Drop `state != "OPEN"` or `isDraft == true`.
4. Reduce against the current user (`me`):
   - `my_last_review` = latest `reviews` entry where `author.login == me` (capture `state`, `submittedAt`).
   - `any_human_review` = any review by a real user (exclude bots: `coderabbitai`, `github-actions`, `*-bot`, `app/*`).
   - `last_commit_ts` = latest `commits[].commit.committedDate`.
   - **Slack thread state** — read with `response_format="detailed"` (mandatory; re-review signals live in Slack, not GitHub). Capture latest author + ts. Detect a re-review signal in any message authored by the PR author *after* `my_last_review.submittedAt`, case-insensitive regex:
     ```text
     ready (for|to) re-?review | please re.?review | addressed | updated.*PR | PTAL | fixed @ | all comments addressed | rebased
     ```
     If the re-review ping mentions someone else (`@<other>`) but my prior review is still open (COMMENTED / CHANGES_REQUESTED with no follow-up from me), still classify as INBOX-REREVIEW and flag the primary-reviewer ambiguity in the dashboard row.

   | Bucket | Condition |
   |---|---|
   | **INBOX-UNREVIEWED** | `my_last_review` is null AND `any_human_review` is false — no human has reviewed yet |
   | **INBOX-REREVIEW** | `my_last_review.state ∈ {COMMENTED, CHANGES_REQUESTED}` AND (`last_commit_ts > my_last_review.submittedAt` OR slack re-review signal after my review) |
   | **WAITING-ON-OTHERS** | `any_human_review` true but `my_last_review` null — someone else owns it |
   | **DONE-BY-ME** | `my_last_review.state == APPROVED` OR my review exists with no new activity since |

   Only INBOX-UNREVIEWED and INBOX-REREVIEW appear in the dashboard. Drop the others; note their counts in the summary so the user knows the scan was exhaustive.

5. Sort INBOX-UNREVIEWED by `posted_at` ascending (oldest first = most painful for the author). Sort INBOX-REREVIEW by `my_last_review.submittedAt` ascending (oldest open feedback first).

### 1.5 Present the dry-run report

Sections in this order:

**🔔 REMIND-DUE — last message from you, ≥48h ago → ready to bump**

| PR | Title | Last from you | Age |
|---|---|---|---|

**⏳ REMIND-RECENTLY-PINGED — last from you, <48h → skip (cooldown)**

| PR | Title | Last from you | Hours ago |
|---|---|---|---|

**👀 YOUR-ACTION — team replied last → you need to respond**

| PR | Title | Last message (≤120 chars, with author) | Notes |
|---|---|---|---|

**📝 OWN-DRAFTS — your WIP, not yet posted for review**

| PR | Title | Last commit | CI | Bucket | Suggested next step |
|---|---|---|---|---|---|

**🧹 STALE — created >6w ago, no activity in 2+ weeks → needs disposition**

| PR | Title | Age | Last activity | Bucket | Suggested disposition |
|---|---|---|---|---|---|

Stale buckets: **WIP/abandoned**, **posted-but-ignored**, **reviewed-stuck-on-you**, **reviewed-stuck-on-team**.

**📥 INCOMING-UNREVIEWED — others' PRs with no human review yet → potential pick up**

| PR | Author | Title | Posted | Age in channel |
|---|---|---|---|---|

**🔁 INCOMING-REREVIEW — you reviewed, dev addressed → potential re-review**

| PR | Author | Title | Your last review | New commits since | Re-review signal |
|---|---|---|---|---|---|

**Excluded** — other-repo PRs without a configured channel, plus `Archived repo: N (repos: …)`.

**Counts** — `WAITING-ON-OTHERS: N · DONE-BY-ME: N` (silently-dropped buckets, for auditability).

End with the action menu:

```text
Proceed?
  (a) Bump REMIND-DUE threads
  (b) Investigate YOUR-ACTION PRs with parallel sub-agents
  (c) Walk through OWN-DRAFTS (decide: flip / finish / close)
  (d) Walk through STALE PRs (decide: close / keep / hand off)
  (e) Open INCOMING-UNREVIEWED for review (browser or sub-agent triage)
  (f) Open INCOMING-REREVIEW with diff-since-my-review
  (g) All of the above
  (h) Cancel
```

**STOP. No actions without explicit approval.**

## Phase 2A — Bump REMIND-DUE threads (only if (a) or (g))

Eligibility is REMIND-DUE only. RECENTLY-PINGED is skipped — Phase 1 already filtered it; do not re-check here.

Post one thread reply per PR via `slack_send_message` with `thread_ts=<parent_ts>`. **Exact message text — do not paraphrase:**

```text
friendly bump <!subteam^S096X6MCB0C>
```

Renders as `friendly bump @smartcontract_core`. The `<!subteam^…>` syntax is mandatory — plain `@smartcontract_core` does not trigger notifications (verified 2026-05-13). For the backend channel, swap to that channel's subteam ID or skip the tag per channel convention.

Confirm each post with its permalink.

## Phase 2B — Walk through OWN-DRAFTS (only if (c) or (g))

For each draft, ask once (or in a small batch):

```text
PR #<n> — <title>  (last commit <X>w ago, CI <status>)
Bucket: <READY-TO-FLIP / NEEDS-WORK / DORMANT / SYNC-PR>
What would you like to do?
  (1) Flip to Ready for Review + post via /post-pr-for-review
  (2) Continue work locally (no action now)
  (3) Close (with reason)
  (4) Investigate first (defer to Phase 3)
  (5) Skip for now
```

Execute the chosen disposition. For (1): `gh pr ready <n>` then invoke `post-pr-for-review`. For (3): `gh pr close --comment "<reason>"`.

## Phase 2C — Walk through STALE (only if (d) or (g))

For each STALE PR:

```text
PR #<n> — <title>  (age <X>w, last activity <Y>w ago)
Bucket: <bucket>
What would you like to do?
  (1) Close (with one-line reason)
  (2) Mark "still working" — post "Still active — target date: <D>" comment
  (3) Hand off / re-assign (you'll name the assignee)
  (4) Convert to draft if not already
  (5) Investigate first (defer to Phase 3)
  (6) Skip
```

Execute. (1) `gh pr close --comment`. (3) `gh pr edit --add-assignee`. (4) `gh pr ready --undo`.

## Phase 2D — Incoming review queue (only if (e), (f), or (g))

For **INCOMING-UNREVIEWED**:

- Show `gh pr view <n> --web` link + a 2-line preview (changed-files count, primary language, linked issue/ticket from PR body).
- Per-PR offer: (i) open in browser, (ii) spawn sub-agent for a ≤200-word triage summary (what changed, risk level, next step), (iii) skip.
- If (ii), use the Phase 3 sub-agent template with this orientation: *"The user has not reviewed this yet. Give them the minimum context to decide whether to review now, defer, or hand off."*

For **INCOMING-REREVIEW**:

- Fetch diff *since my last review*:
  ```bash
  gh pr view <n> --json reviews \
    --jq '.reviews[] | select(.author.login=="<me>") | .commit.oid' | tail -1
  gh pr diff <n> --color=never --commit-range <last_review_sha>..HEAD
  ```
- Show filename list + line-count delta; quote the dev's "ready for re-review" message from the Slack thread; list my still-open inline review comments:
  ```bash
  gh api repos/<o>/<r>/pulls/<n>/comments
  ```
  filtered by `user.login == me` AND `in_reply_to_id == null`.
- Per-PR offer: (i) open `--web` link to the "Files changed since" view, (ii) spawn sub-agent to verify the dev addressed each of my original comments and report mismatches, (iii) skip.

Never auto-approve, auto-comment, or auto-request-changes. The skill routes; the human reviews.

## Phase 3 — Sub-agent investigation (only if (b) or (g), or option (5) from Phase 2B/2C)

Dispatch one sub-agent per PR, in parallel. Each sub-agent:

1. `gh pr view <n> --repo <owner>/<repo> --json reviewDecision,reviews,comments,statusCheckRollup,mergeable,mergeStateStatus`
2. `gh api repos/<owner>/<repo>/pulls/<n>/comments` (inline review comments)
3. `gh api repos/<owner>/<repo>/issues/<n>/comments` (PR discussion)
4. Read the Slack thread (orchestrator passes it in — sub-agent has no other context).
5. Identify (a) what the team is blocking on, (b) which comments are unresolved, (c) ONE concrete next step.
6. Report <300 words in the format below.

Sub-agent prompt template (self-contained):

```text
You are investigating LI.FI PR <URL>. The user is the author. The team posted comments after the user's last reply; the user needs to decide what to do next.

1. Pull GitHub review state with the `gh` commands above.
2. Read this Slack thread: <paste detailed thread text>.
3. Summarise what the team is asking for and propose ONE concrete next step.

Be terse. Report under 300 words:
## PR #<n>
### Findings
- ...
### Suggested action
- ...
### Confidence: high | medium | low
```

Orchestrator consolidates all reports:

```text
## Sub-agent findings — N PRs investigated
<each PR's findings>

Next?
  (1) Implement the suggested actions one PR at a time (interactive)
  (2) Implement all in parallel via sub-agents
  (3) Just give me the list; I'll act manually
  (4) Done
```

**STOP. No code changes without per-PR approval.**

## Phase 4 — Implementation (only if (1) or (2))

Per PR:

- `gh pr checkout <n>` in the right repo.
- Apply changes per the suggested action.
- Run lints/tests locally.
- Push.
- Reply in the Slack thread linking the new commit and re-requesting review.

Do **not** invoke `/pr-ready` here — that's the pre-create gate, not the per-iteration gate. Re-request review via `gh pr edit --add-reviewer` or just push and ping.

## What this skill never does

- Touches closed or merged PRs.
- Auto-reminds on STALE PRs (always a human call).
- Re-pings inside the 48h cooldown window.
- Pushes code without per-PR approval in Phase 4.
- Submits a code review on the user's behalf — no auto-approve, auto-comment, auto-request-changes. The incoming queue is read-only routing; the human reviews.
