---
name: resolve-audit-issues
description: Work through an external auditor's GitHub issues for a contracts PR — discover the audit repo from Slack, load every finding, triage fix-vs-acknowledge in one gate, implement each fix as its own commit on a remediation branch, then reply to each issue with "fixed <commit>" or "acknowledged <reason>". Use when an audit is completed and the findings live as issues in the auditor's repo.
usage: /resolve-audit-issues <PR_NUMBER_OR_URL_OR_FACET> [--audit-repo <owner/repo>]
---

# Resolve Audit Issues

> **Usage**: `/resolve-audit-issues <PR_NUMBER_OR_URL_OR_FACET> [--audit-repo <owner/repo>]`

An external auditor (Sujith, Burrasec) delivers findings as **GitHub issues in their own
repo**, one issue per finding, severity-labelled. This command drives the response end to end:
discover that repo, read every finding, decide per issue whether to **fix** or **acknowledge**,
implement fixes one-commit-each on a fresh remediation branch, and reply to each issue with a
commit link or a reason.

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

## Auditors (for Slack discovery)

| Auditor | Channel | Repo owner (typical) |
|---|---|---|
| Sujith Somraaj | `#dev-sc-audit` | `sujithsomraaj` |
| Burrasec (Josip Koncurat) | `#dev-sc-audit-burrasec` | `burrasec` / firm org |

The owner column is a hint, not a rule — always confirm the discovered repo with the user
before trusting it (Step 1).

---

## Step 0 — Resolve the contracts PR

The argument is a PR number, a `lifinance/contracts` PR URL, or a facet name.

```bash
gh pr view <PR> --repo lifinance/contracts \
  --json number,title,body,url,headRefName,commits,files,labels,state
```

Capture: `number`, `url`, `headRefName`, the **last** `commits[].oid` (the audited head — the
commit the auditor reviewed; re-run with `--json commits` if the array came back empty), and
the facet/contract names from the title brackets. Extract any `EXSC-\d+` ticket from body /
title / branch for later PR linkage.

If given a facet name with no PR, find the PR: `gh pr list --repo lifinance/contracts --search
"<Facet>" --state all`. If ambiguous, list matches and ask.

## Step 1 — Discover the audit repo

If `--audit-repo <owner/repo>` was passed, use it and skip discovery.

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

```bash
gh issue list --repo <owner>/<repo> --state open --limit 100 \
  --json number,title,labels
```

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

```bash
~/.claude/scripts/contracts-wt-add.sh audit/<facet>-remediation
# then, in the new worktree, base the branch on the audited head:
git checkout -b audit/<facet>-remediation <audited_oid_or_pr_head>
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

Present one table, most-severe first:

```text
| # | Sev  | Title                                   | Proposal    | Rationale / residual risk               |
|---|------|-----------------------------------------|-------------|-----------------------------------------|
| 3 | Med  | Native swap calldata reused with …      | Fix         | Bind amount into calldata; …            |
| 2 | Med  | Mayan refund recipient not validated    | Acknowledge | Forwarder is trusted+immutable; …       |
| … |      |                                         |             |                                         |
```

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

Before anything leaves the machine, show the user the **full diff set** (all fix commits) and
the **drafted reply for every issue**. This is a content check — the triage gate already
approved the plan.

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

**Posting to the auditor's repo is an external publish.** Draft every reply, show them all, and
post only after the user's explicit **yes** in Step 7's review. Then, per issue:

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

Report a summary:

```text
Remediation PR: <new_pr_url>  (draft)
Replies posted to <owner>/<repo>:
  fixed: #1 #3 #8 …   (N commits)
  acknowledged: #2 #6 …   (M)
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
