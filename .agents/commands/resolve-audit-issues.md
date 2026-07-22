---
name: resolve-audit-issues
description: Work through an external auditor's GitHub issues for a contracts PR — discover the audit repo from Slack, load every finding, triage fix-vs-acknowledge in one gate, implement each fix as its own commit on a remediation branch, reply to each issue with "fixed <commit>" or "acknowledged <reason>", then post a Slack wrap-up nudging the auditor and pinging @smartcontract_core to re-review. Use when an audit is completed and the findings live as issues in the auditor's repo.
usage: /resolve-audit-issues <PR_NUMBER_OR_URL_OR_FACET> [--audit-repo <owner/repo>]
---

# Resolve Audit Issues

> **Usage**: `/resolve-audit-issues <PR_NUMBER_OR_URL_OR_FACET> [--audit-repo <owner/repo>]`

An external auditor (Sujith, Burrasec) delivers findings as **GitHub issues in their own
repo**, one issue per finding, severity-labelled. This command drives the response end to end:
discover that repo, read every finding, decide per issue whether to **fix** or **acknowledge**,
implement fixes one-commit-each on a fresh remediation branch, reply to each issue with a
commit link or a reason, and post a Slack wrap-up nudging the auditor + pinging the SC team.

**Control model — one gate.** The command analyses *all* issues and presents a single triage
table. You approve/edit the whole plan once. Then it executes autonomously, pausing only for
(a) genuinely ambiguous findings it flagged, and (b) the mandatory pre-post review in Step 8.

**One commit per fix** (LI.FI convention: each finding fixed or acknowledged in isolation).
Acknowledged findings produce no commit.

---

## Scope

- **In scope**: discovery, triage, fixing, per-issue replies on the auditor's repo.
- **Out of scope — do NOT do these here**:
  - Adding the audit report PDF to `audit/auditLog.json` → that's `/add-audit`, run later once
    the auditor signs off on the fixes.
  - Merging the remediation PR or any multisig rollout → `/multisig-rollout`.
  - Requesting the audit in the first place → `/request-audit`.

## Auditors (for Slack discovery + the wrap-up nudge)

| Auditor | Channel | webhook `--channel` | env var | Auditor mention | Repo owner (typical) |
|---|---|---|---|---|---|
| Sujith Somraaj | `#dev-sc-audit` | `dev-sc-audit` | `WEBHOOK_DEV_SC_AUDIT` | `<@U05GN6XH57T>` | `sujithsomraaj` |
| Burrasec (Josip Koncurat) | `#dev-sc-audit-burrasec` | `dev-sc-audit-burrasec` | `WEBHOOK_DEV_SC_AUDIT_BURRASEC` | `<@U094M720QDP>` | `burrasec` / firm org |

The owner column is a hint, not a rule — always confirm the discovered repo with the user
before trusting it (Step 1). SC-team review tag: `@smartcontract_core` MUST be sent as
`<!subteam^S096X6MCB0C>` — a plain `@…` does not notify.

---

## Step 0 — Resolve the contracts PR

The argument is a PR number, a `lifinance/contracts` PR URL, or a facet name.

```bash
gh pr view <PR> --repo lifinance/contracts \
  --json number,title,body,url,headRefName,commits,files,labels,state
```

Capture: `number`, `url`, `headRefName`, the **last** `commits[].oid` (the audited head — the
commit the auditor reviewed; re-run with `--json commits` if the array came back empty), the
facet/contract **names and versions** from the title brackets (e.g. `MayanFacet v2.0.0` →
`facet = MayanFacet`, `version = v2.0.0` — the version is needed for the Step 9 wrap-up), and a
ref-safe **slug** of the primary facet (lowercase, non-`[a-z0-9._-]` → `-`) for the branch name
in Step 4. Extract any `EXSC-\d+` ticket from body / title / branch for later PR linkage.

If given a facet name with no PR, find the PR: `gh pr list --repo lifinance/contracts --search
"<Facet>" --state all`. If ambiguous, list matches and ask.

## Step 1 — Discover the audit repo

If `--audit-repo <owner/repo>` was passed, use it and skip the Slack search — but still
**identify the auditor** (and therefore the channel + mention needed for Step 9) from the repo
owner via the Auditors table; if the owner doesn't map to a known auditor, ask the user which
auditor/channel it is. Never leave the auditor unresolved just because discovery was skipped.

Otherwise search Slack for the auditor's repo link tied to this facet. The audit-completion
message names the findings repo (e.g. `github.com/<auditor>/lifi-<facet>-v<version>`):

- Search the audit channels for the facet name and a `github.com/…` link:
  `slack_search_public_and_private` scoped to `#dev-sc-audit` / `#dev-sc-audit-burrasec` with
  the facet name; look for the most recent message from the auditor containing a repo URL that
  is **not** `lifinance/contracts`.
- Also read the thread of the original audit request (the PR is usually posted there) — the
  auditor's "the audit is completed, findings here: <repo>" reply is the highest-signal source.

Parse `owner/repo` from the link. **Present the match and confirm before trusting it:**

```text
Audit repo: <owner>/<repo>  (from <auditor> in #<channel>, <date>)
Findings PR/commit audited: <pr_url>/commits/<audited_oid>
Proceed with this repo?  (yes / paste the correct owner/repo)
```

If Slack yields nothing, ask the user for the repo directly — don't guess.

## Step 2 — Ensure repo access (auto-accept invite)

The auditor's findings repo is private; you need collaborator access.

```bash
gh api /user/repository_invitations \
  --jq '.[] | {id, repo: .repository.full_name}'
```

- If a pending invitation to the discovered repo exists → **accept it automatically** (no
  confirmation needed — pre-authorised for this workflow):

  ```bash
  gh api -X PATCH /user/repository_invitations/<invitation_id>
  ```

  Report `✅ Accepted invite to <owner>/<repo>`.
- If already a collaborator (issue list in Step 3 succeeds) → skip silently.
- If no invite and no access → tell the user to ask the auditor to add them; stop.

## Step 3 — Load all findings

Load **every** open issue — do not cap. `gh issue list --limit N` silently truncates at `N`, so
page through the REST API instead:

```bash
gh api --paginate repos/<owner>/<repo>/issues \
  -f state=open --jq '.[] | select(.pull_request | not) | {number, title}'
```

(`--paginate` follows every page; the `pull_request` filter drops PRs, which the issues
endpoint also returns.) If you do use `gh issue list`, set a limit well above the issue count
and **fail loudly** if the returned count equals the limit — that means results were truncated.

For each issue, pull the full body (and any existing comments, so you don't re-answer a
finding already resolved in a prior run):

```bash
gh issue view <n> --repo <owner>/<repo> --json number,title,body,labels,state,comments
```

Extract per issue: severity (from the `Severity: …` label), title, description, the exact
code location(s) it references, and the auditor's suggested remediation if any. Skip issues
that already carry a `fixed`/`acknowledged` reply from you unless the user asks to redo them.

## Step 4 — Set up the remediation workspace

Fixes land on a **fresh remediation branch based off the audited PR's head** (not the existing
PR branch), so remediation history is isolated and gets its own PR.

Create a dedicated worktree off the audited branch so the diamond invariants and tests build
cleanly and you never touch the main checkout:

Use the ref-safe `<slug>` from Step 0 (never the raw facet name) for both the worktree path
and the branch, so spaces/slashes can't break branch creation:

```bash
~/.claude/scripts/contracts-wt-add.sh audit/<slug>-remediation
# then, in the new worktree, base the branch on the audited head:
git checkout -b audit/<slug>-remediation <audited_oid_or_pr_head>
git submodule update --init --recursive
bun install && bun typechain:incremental   # avoid the fresh-worktree lint-staged trap
```

Verify the base is right: `git log <pr_head>..HEAD` should be empty (you branched from the PR
head, not from stale main). See the worktree memories for the submodule / typechain / prettier
traps.

## Step 5 — Triage (the one gate)

For **every** issue, map the finding to the code, form a recommendation, and assess residual
risk. Follow the Solidity rules that apply to the touched files (`100-solidity-basics`,
`101-solidity-contracts`, `102-facets`, `104-receiver-contracts`, `105-security`) — a fix must
not weaken diamond/selector/storage invariants or governance flows.

Present one table, most-severe first. It must be **self-contained** — the reader should
understand each finding and our response without opening the issue. Keep a **Finding** column
(a neutral 1–2 sentence summary of what the auditor actually reported — the observation + the
affected code/path, in your words, not a copy of the title) separate from **Rationale**
(*our* decision reasoning + residual risk):

```text
| # | Sev  | Title                                | Finding (what the auditor reported)                                  | Proposal    | Rationale / residual risk               |
|---|------|--------------------------------------|----------------------------------------------------------------------|-------------|-----------------------------------------|
| 3 | Med  | Native swap calldata reused …        | `swapAndForwardEth` forwards the original `swapData` built for the   | Fix         | Bind realized amount into calldata; …   |
|   |      |                                      | quoted amount, so a different realized input reverts or strands …    |             |                                         |
| 2 | Med  | Mayan refund recipient not validated | Facet validates the destination receiver but never the order's own   | Acknowledge | Forwarder is trusted+immutable; …       |
|   |      |                                      | refund identity (`trader`/`refundAddr`), so refunds can go elsewhere | |          |                                         |
```

The **Finding** column is a faithful summary of the auditor's issue body, not an assessment —
never soften or pre-judge it there; your judgement belongs in **Rationale**. Keep it tight but
complete enough that the fix/acknowledge decision is legible on its own.

For each **Acknowledge**, the rationale must be a real reason the finding is a non-issue or an
accepted trade-off (trust boundary, gas cost, out-of-scope by design) — never "won't fix" with
no basis. For anything you cannot confidently classify, add it to a short **Questions for you**
list below the table rather than guessing.

Then stop:

```text
Approve this plan? Reply:
  • "go" to execute as-is
  • edits, e.g. "#7 fix not acknowledge", "#5 acknowledge because <reason>"
  • answers to the questions above
```

**Wait for approval.** Re-render the table if edited, until the user says go.

## Step 6 — Execute (per approved plan)

Process issues independently. For each **Fix**:

1. Implement the minimal change in `src/…`. Reuse existing libraries/helpers; keep facets thin.
2. Build + run the targeted tests:

   ```bash
   forge build
   forge test --match-contract <Facet>Test   # or the closest matching suite
   ```

   (Reproduce under the deploy toolchain if the finding touches a stack-depth-sensitive path —
   see the london/0.8.17 memory.)
3. Commit — **one commit per finding** — with a message that names the issue:

   ```text
   fix(<Facet>): <short finding title> (audit <owner>/<repo>#<n>)
   ```

   Record the full commit SHA for the reply.

For each **Acknowledge**: no code, no commit — just carry the approved rationale to Step 8.

If a fix turns out larger/riskier than triage assumed, stop and re-surface that one issue
rather than ballooning the diff.

## Step 7 — Final review, push, open the remediation PR

**One publish gate for everything external.** Before anything leaves the machine, render
*together* in a single review: the **full diff set** (all fix commits), the **drafted reply for
every issue** (Step 8), and the **drafted Slack wrap-up** (Step 9). The user gives **one**
approval that covers all external posts — there is no second gate later. This is a content
check; the triage gate already approved the plan.

On go:

1. Push the branch (SSH if it touches `.github/workflows/**` — see the workflow-scope memory).
2. Open the remediation PR from `.github/pull_request_template.md`, linking the `EXSC-\d+`
   ticket. Title e.g. `fix(<Facet>): address <auditor> audit findings`. Open as **draft** if
   the change trips the audit/version CI gate (it will — struct/selector/version churn) so the
   audit-verification workflow skips until the auditor re-signs. Leave the reviewer checklist
   unchecked.
3. Capture the new PR number and each fix commit's canonical permalink:
   `https://github.com/lifinance/contracts/commit/<full_sha>`

## Step 8 — Reply to each issue

Posting happens only after the single Step 7 approval. Then, per issue, and **tracking the
result of each** (you'll need it to gate Step 9):

```bash
# fixed
gh issue comment <n> --repo <owner>/<repo> \
  --body-file /tmp/reply-<n>.md   # body: "fixed https://github.com/lifinance/contracts/commit/<full_sha>"

# acknowledged
gh issue comment <n> --repo <owner>/<repo> \
  --body-file /tmp/reply-<n>.md   # body: "acknowledged — <reason>"
```

Reply body format (exact wording the team uses):

- Fixed: `fixed <commit_permalink>` — optionally one sentence on what changed.
- Acknowledged: `acknowledged — <reason>` — the approved rationale from triage.

**Leave issues open** — the auditor closes each one on verification. Do not close them yourself
unless the user says so.

If any `gh issue comment` failed, keep that issue in a **pending** set — it gates Step 9.

## Step 9 — Slack wrap-up (nudge auditor + ping SC team)

**Gate: only run this if every issue reply from Step 8 succeeded.** If any reply is still
pending, do **not** post the wrap-up — it would claim "all issues are addressed" while some
never got a reply. Instead report which issues failed and stop; the user re-runs after those
replies land.

When all replies are confirmed, post one message (already approved in Step 7) to the auditor's
audit channel: nudge the auditor that all findings are addressed, and ping `@smartcontract_core`
to review the findings and our responses. Webhooks can't thread, so this is one self-contained
channel message (not a thread reply).

Before writing the message file, **validate that no `{...}` placeholder is unresolved** —
`{Facet}`, `{version}`, `{auditor_mention}`, `{webhook_channel}`, the counts, and
`{remediation_pr_url}` must all have real values (from Step 0 and the auditor identified in
Step 1). If any is missing, stop and ask rather than posting a half-filled message.

Draft (backtick code style per the auditor-facing convention — wrap contract/version/PR refs):

```text
Audit remediation for `{Facet}` `{version}` is ready for re-review.

Findings: {N} total — {fixed_count} fixed, {ack_count} acknowledged.
Remediation PR: {remediation_pr_url}

Hey {auditor_mention} — all issues are addressed; please take another look when you get a chance 🙏
<!subteam^S096X6MCB0C> please review the audit findings and our responses.
```

Resolve `{auditor_mention}` and the channel from the Auditors table (the auditor identified in
Step 1). Write the message to a temp file and post:

```bash
bunx tsx script/utils/send-slack-webhook-message.ts \
  --channel {webhook_channel} \
  --message-file /tmp/audit-wrapup-<pr>.txt
```

Interpret the exit code (same convention as `request-audit`):

| Exit | Meaning | Action |
|---|---|---|
| `0` | posted | `✅ Posted wrap-up to #{channel}` |
| `2` | `WEBHOOK_*` env var not set | Print the drafted message and tell the user to post it manually; name the missing env var (URL in 1Password → Developers Smart Contract → Webhooks SC Channels) |
| `1` | Slack / network error | Report stderr, do **not** retry |

Then report the final summary. The **Slack** line must reflect the actual webhook result — not
a fixed string: `posted to #<channel>` (exit 0), `manual fallback — post it yourself` (exit 2),
or `failed — <error>` (exit 1):

```text
Remediation PR: <new_pr_url>  (draft)
Replies posted to <owner>/<repo>:
  fixed: #1 #3 #8 …   (N commits)
  acknowledged: #2 #6 …   (M)
Slack: posted to #<channel> — nudged <auditor> + pinged @smartcontract_core
Awaiting auditor re-review.
```

---

## Error handling

| Situation | Action |
|---|---|
| Audit repo not found in Slack | Ask the user for `owner/repo`; don't guess |
| No repo access and no pending invite | Ask the auditor to add you; stop |
| Issue references code not on the audited head | Flag in triage; the finding may target a different commit — confirm the audited commit with the user |
| A fix breaks tests | Keep the issue in "Fix" but stop and surface it; don't commit a red fix |
| `gh issue comment` fails for one issue | Report it, continue with the rest; the others already posted |

## Why this design

- **Fresh remediation branch, not the audited PR branch**: keeps the remediation diff and its
  audit gate isolated from the original PR, and gives the auditor a clean PR to re-review.
- **One triage gate, then autonomous**: audit findings on a production bridge facet need human
  judgement on fix-vs-acknowledge, but re-approving each mechanical fix is friction — so the
  judgement is front-loaded into one table and execution runs unattended.
- **Replies gated behind explicit confirmation**: posting to an external repo is a publish
  action; the pre-post review is non-negotiable regardless of the triage approval.
