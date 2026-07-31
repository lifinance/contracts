---
name: SC feature-PR lifecycle
description: Canonical stage order for a smart contract feature PR — peer review and BE integration come BEFORE the audit — and how the repo automation maps to each stage
globs:
  - 'src/**/*.sol'
  - 'test/**/*.t.sol'
  - 'audit/**/*.json'
  - 'audit/**/*.pdf'
alwaysApply: false # for Cursor
paths:
  - 'src/**/*.sol'
  - 'test/**/*.t.sol'
  - 'audit/**/*.json'
  - 'audit/**/*.pdf'
---

## Stage order is non-negotiable

**Peer review and BE integration happen BEFORE the audit. The audit is the last
gate before merge, not a prerequisite for review.** Never plan work, advise a
user, or block a step on the assumption that a contract must be audited before
it can be posted for peer review.

## Lifecycle stages

1. **Start** — work begins from a Linear ticket (EXSC team); create one if none
   exists.
2. **Self-test** — implement, then test and verify locally (unit tests,
   coverage, self-review) until everything looks good.
3. **PR** — create the PR from the repo template, switch it to **ready for
   review**, and address all CodeRabbit and Aikido comments (wait for the bots
   to finish if needed).
4. **Peer review** — post the PR to Slack `#dev-sc-review`
   (`/post-pr-for-review`).
5. **Iterate** — address reviewer comments until all threads are resolved. The
   SC side is now ready for BE integration.
6. **BE hand-off** — inform the backend developers (usually in
   `#dev-api-expansion`) that the topic is ready for integration and testing.
7. **BE verification** — BE integrates and reports back; fix anything they
   surface. No findings means the contract counts as fully tested.
8. **Audit** — request the audit (`/request-audit`) and resolve the findings
   (`/resolve-audit-issues`).
9. **File the audit** — add the report PDF and update `audit/auditLog.json`
   (`/add-audit`). This lands as a new commit, which **dismisses the stale
   peer-review approval — that is expected**; re-request review.
10. **Final review & merge** — obtain a fresh approval, then merge.

## How the automation maps to the stages

- **All new PRs open as drafts** (`createPRsAsDraft.yml`). Flipping to "ready
  for review" is a deliberate step within stage 3, never automatic.
- **`VersionControlAndAuditVerification`**
  (`versionControlAndAuditCheck.yml`) enforces contract version bumps for
  audit-relevant changes and, on PRs targeting `main`, requires an
  `audit/auditLog.json` entry (report at the logged path, audited commit in the
  PR) for every changed contract. It assigns `AuditRequired` and **stays red
  until stage 9 is done**. A failing audit check during stages 3–7 is expected
  and does not block peer review or BE integration — do not "fix" it early by
  adding audit entries before the audit happened.
- **`SC Core Dev Approval Check`** (`ensureSCCoreDevApproval.yml`) requires at
  least one approval from the smart-contract core team and re-evaluates on
  every review event — including the approval dismissal caused by the stage-9
  audit commit, which is why stage 10 needs a fresh approval.
- **`securityAlertsReview.yml`** is the only workflow that reverts a ready PR
  back to draft. It fires on `ready_for_review` and force-drafts when Olympix
  code-scanning alerts are unresolved, dismissed without a comment, or
  dismissed with the invalid reason "Used in tests" (only production code is
  analyzed). The fix is resolving or properly dismissing the alerts (comment +
  valid reason), then marking the PR ready again — never an audit entry.
- **Audit labels are protected** (`protectAuditLabels.yml`): `AuditRequired`,
  `AuditNotRequired`, and `AuditCompleted` may only be set or removed by the CI
  bot — never assign or remove them manually.
