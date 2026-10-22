---
name: resolve-audit-issues
description: Works through an external auditor's GitHub-issue findings for a contracts PR — one fix-vs-acknowledge triage gate, one commit per fix on a remediation branch, a reply on every issue, then a Slack wrap-up. Use when an audit is completed and the findings live as issues in the auditor's repo.
usage: /resolve-audit-issues <PR_NUMBER_OR_URL_OR_FACET> [--audit-repo <owner/repo>]
---

# Resolve Audit Issues

> **Usage**: `/resolve-audit-issues <PR_NUMBER_OR_URL_OR_FACET> [--audit-repo <owner/repo>]`

External auditors (Sujith, Burrasec) deliver findings as GitHub issues in their own repo, one
issue per finding, severity-labelled.

**Control model:** analyse all issues, present one triage table, get one approval. Then execute
autonomously, pausing only for findings flagged as ambiguous and for the single pre-publish
review in Step 7. One commit per fix; acknowledged findings produce no commit.

**Out of scope:** adding the report to `audit/auditLog.json` (`/add-audit`, after the auditor
signs off on the fixes); merging or rollout (`/multisig-rollout`); requesting the audit
(`/request-audit`).

## Auditors

| Auditor | Channel | webhook `--channel` | env var | Auditor mention | Repo owner (typical) |
|---|---|---|---|---|---|
| Sujith Somraaj | `#dev-sc-audit` | `dev-sc-audit` | `WEBHOOK_DEV_SC_AUDIT` | `<@U05GN6XH57T>` | `sujithsomraaj` |
| Burrasec (Josip Koncurat) | `#dev-sc-audit-burrasec` | `dev-sc-audit-burrasec` | `WEBHOOK_DEV_SC_AUDIT_BURRASEC` | `<@U094M720QDP>` | `burrasec` / firm org |

The owner column is a hint — always confirm the discovered repo with the user (Step 1).
`@smartcontract_core` must be sent as `<!subteam^S096X6MCB0C>`; a plain `@…` does not notify.

## Step 0 — Resolve the contracts PR

The argument is a PR number, a `lifinance/contracts` PR URL, or a facet name.

```bash
gh pr view <PR> --repo lifinance/contracts \
  --json number,title,body,url,headRefName,commits,files,labels,state
```

Capture: `number`, `url`, `headRefName`, the **last** `commits[].oid` (the audited head; re-run
with `--json commits` if the array came back empty), the facet/contract names and versions from
the title brackets (e.g. `MayanFacet v2.0.0` — the version is needed in Step 9), and a ref-safe
**slug** of the primary facet (lowercase, non-`[a-z0-9._-]` → `-`) for Step 4. Extract any
`EXSC-\d+` ticket from body / title / branch.

Given a facet name with no PR: `gh pr list --repo lifinance/contracts --search "<Facet>"
--state all`. If ambiguous, list matches and ask.

## Step 1 — Discover the audit repo

With `--audit-repo`, skip the Slack search but still identify the auditor (channel + mention for
Step 9) from the repo owner via the Auditors table; if the owner maps to no known auditor, ask.

Otherwise find the findings repo link (e.g. `github.com/<auditor>/lifi-<facet>-v<version>`) in
Slack:

- `slack_search_public_and_private` in `#dev-sc-audit` / `#dev-sc-audit-burrasec` for the facet
  name; take the most recent auditor message with a repo URL that is not `lifinance/contracts`.
- The thread of the original audit request — the auditor's "audit completed, findings here"
  reply is the highest-signal source.

Confirm before trusting it:

```text
Audit repo: <owner>/<repo>  (from <auditor> in #<channel>, <date>)
Findings PR/commit audited: <pr_url>/commits/<audited_oid>
Proceed with this repo?  (yes / paste the correct owner/repo)
```

If Slack yields nothing, ask the user for the repo — don't guess.

## Step 2 — Ensure repo access

The findings repo is private.

```bash
gh api /user/repository_invitations \
  --jq '.[] | {id, repo: .repository.full_name}'
```

- Pending invite whose owner matches the Step 1 auditor → show it (`<owner>/<repo>`, id) and ask
  the user to approve accepting it (with `--audit-repo` this is the first time they see the
  repo), then `gh api -X PATCH /user/repository_invitations/<invitation_id>`.
- Only invite is for a non-matching owner → do not accept; surface it and ask.
- Already a collaborator (Step 3 succeeds) → skip.
- No invite and no access → tell the user to ask the auditor to add them; stop.

## Step 3 — Load all findings

Load every open issue. `gh issue list --limit N` silently truncates at `N`, so page the REST API
(the `pull_request` filter drops PRs, which this endpoint also returns):

```bash
gh api --paginate repos/<owner>/<repo>/issues \
  -f state=open --jq '.[] | select(.pull_request | not) | {number, title}'
```

Per issue, pull body and comments:

```bash
gh issue view <n> --repo <owner>/<repo> --json number,title,body,labels,state,comments
```

Extract severity (the `Severity: …` label), title, description, referenced code locations, and
any suggested remediation. Skip issues that already carry a `fixed`/`acknowledged` reply from us
unless the user asks to redo them.

## Step 4 — Remediation workspace

Fixes land on a fresh branch off the audited head (not the existing PR branch), so remediation
gets its own PR. Use the Step 0 `<slug>`, never the raw facet name:

```bash
git worktree add ../<slug>-remediation <audited_oid_or_pr_head> -b audit/<slug>-remediation
cd ../<slug>-remediation
git submodule update --init --recursive
bun install && bun typechain:incremental   # avoid the fresh-worktree lint-staged trap
ln -s <main-checkout>/.env .env            # framework/deploy scripts read the shared .env
```

Verify `git log <pr_head>..HEAD` is empty (branched from the PR head, not stale main).

## Step 5 — Triage (the one gate)

For every issue, map the finding to code, recommend Fix or Acknowledge, and assess residual
risk. Apply the Solidity rules for the touched files (`100-solidity-basics`,
`101-solidity-contracts`, `102-facets`, `104-receiver-contracts`, `105-security`); a fix must
not weaken diamond/selector/storage invariants or governance flows.

Present one table, most-severe first, self-contained so the reader needn't open the issue.
**Finding** is a faithful, neutral 1–2 sentence summary of what the auditor reported (in your
words, not the title, never softened); **Rationale** holds our judgement and residual risk:

```text
| # | Sev | Title                         | Finding (what the auditor reported)            | Proposal | Rationale / residual risk             |
|---|-----|-------------------------------|------------------------------------------------|----------|---------------------------------------|
| 3 | Med | Native swap calldata reused … | `swapAndForwardEth` forwards `swapData` built  | Fix      | Bind realized amount into calldata; … |
|   |     |                               | for the quoted amount, so a different input …  |          |                                       |
```

Every **Acknowledge** needs a real reason (trust boundary, gas cost, out of scope by design) —
never a bare "won't fix". List anything you can't confidently classify under **Questions for
you** below the table. Then stop:

```text
Approve this plan? Reply:
  • "go" to execute as-is
  • edits, e.g. "#7 fix not acknowledge", "#5 acknowledge because <reason>"
  • answers to the questions above
```

Re-render the table after edits until the user says go.

## Step 6 — Execute

Per **Fix**:

1. Minimal change in `src/…`; reuse existing libraries/helpers; keep facets thin.
2. Build and test:

   ```bash
   forge build
   forge test --match-contract <Facet>Test   # or the closest matching suite
   ```

   If the finding touches a stack-depth-sensitive path, also build with
   `FOUNDRY_PROFILE=solc_floor` (the solc 0.8.17 / london pair london-EVM networks ship).
3. One commit per finding:

   ```text
   fix(<Facet>): <short finding title> (audit <owner>/<repo>#<n>)
   ```

   Record the full SHA. If the pre-commit hook reports a Solhint error, fix the code — never
   `--no-verify`.

If a fix breaks tests, don't commit it; stop and surface that issue. If a fix turns out larger or
riskier than triage assumed, re-surface that one issue rather than ballooning the diff. If an
issue references code not on the audited head, flag it — confirm the audited commit with the
user.

## Step 7 — Final review, push, open the remediation PR

One publish gate for everything external: render together the full diff set, the drafted reply
for every issue (Step 8), and the drafted Slack wrap-up (Step 9). One approval covers all
external posts; there is no later gate.

On go:

1. Push (over SSH if it touches `.github/workflows/**` — an HTTPS push with a `gh` token lacking
   the `workflow` scope is refused).
2. Open the PR from `.github/pull_request_template.md`, linking the `EXSC-\d+` ticket; title
   e.g. `fix(<Facet>): address <auditor> audit findings`. Open as **draft** if it trips the
   audit/version CI gate (struct/selector/version churn will) so audit verification skips until
   the auditor re-signs. Leave the reviewer checklist unchecked.
3. Capture the PR number and each fix's permalink
   `https://github.com/lifinance/contracts/commit/<full_sha>`.

## Step 8 — Reply to each issue

```bash
gh issue comment <n> --repo <owner>/<repo> --body-file /tmp/reply-<n>.md
```

Reply body (exact team wording):

- Fixed: `fixed <commit_permalink>` — optionally one sentence on what changed.
- Acknowledged: `acknowledged — <reason>` — the approved triage rationale.

Leave issues open — the auditor closes each on verification. If a comment fails, report it,
continue with the rest, and keep that issue in a **pending** set.

## Step 9 — Slack wrap-up

Only if the pending set is empty — otherwise the message would claim all issues are addressed.
Report the failed issues and stop; the user re-runs after those replies land.

Post one self-contained channel message (webhooks can't thread) to the auditor's channel. Before
writing the file, check no `{...}` placeholder is unresolved; if any is, stop and ask. Wrap
contract/version/PR refs in backticks:

```text
Audit remediation for `{Facet}` `{version}` is ready for re-review.

Findings: {N} total — {fixed_count} fixed, {ack_count} acknowledged.
Remediation PR: {remediation_pr_url}

Hey {auditor_mention} — all issues are addressed; please take another look when you get a chance 🙏
<!subteam^S096X6MCB0C> please review the audit findings and our responses.
```

```bash
bunx tsx script/utils/send-slack-webhook-message.ts \
  --channel {webhook_channel} \
  --message-file /tmp/audit-wrapup-<pr>.txt
```

| Exit | Meaning | Action |
|---|---|---|
| `0` | posted | `✅ Posted wrap-up to #{channel}` |
| `2` | `WEBHOOK_*` env var not set | Print the message, tell the user to post it manually, name the missing env var (URL in 1Password → Developers Smart Contract → Webhooks SC Channels) |
| `1` | Slack / network error | Report stderr, do not retry |

Final summary — the Slack line reflects the actual exit (`posted to #<channel>`, `manual
fallback — post it yourself`, or `failed — <error>`):

```text
Remediation PR: <new_pr_url>  (draft)
Replies posted to <owner>/<repo>:
  fixed: #1 #3 #8 …   (N commits)
  acknowledged: #2 #6 …   (M)
Slack: posted to #<channel> — nudged <auditor> + pinged @smartcontract_core
Awaiting auditor re-review.
```
