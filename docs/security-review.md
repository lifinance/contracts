# LI.FI Security Review Pipeline

> Tracker: [EXP-440](https://linear.app/lifi-linear/issue/EXP-440).
> This document is the operational manual for the automated security review
> that runs on every PR. Read this before you waive a finding, override the
> check, or add new rules.

## Setup (one-time, per repo)

Before the workflow can run for the first time, a repo admin must:

1. **Create a GitHub Environment** named `security-review` (Settings → Environments → New environment). This isolates the Anthropic credentials.
2. **Add `ANTHROPIC_API_KEY`** as an _environment secret_ on that environment (not a plain repo secret).
3. **Enable GitHub Code Scanning** (Settings → Code security and analysis → Code scanning). The curated SARIF upload (Stage 3) requires it. Stage 1 tool output is not uploaded — it is archived as a run artifact and fed to Stage 2 triage.
4. (Optional, recommended) Add required reviewers on the environment so the AI triage step can't run without approval on forks.

> **First run is post-merge.** `claude-code-action` only runs when this
> workflow file is byte-identical to the copy on the default branch (its
> built-in guard against a PR editing the review workflow to exfiltrate the
> API key). So Stage 2 stays inert on the PR that introduces the workflow and
> first runs for real on the next PR after this lands on the default branch.
> Stage 1 (Slither/Semgrep) and the sticky comment are unaffected and run on
> any branch.

## Architecture

The pipeline is intentionally **a thin LI.FI layer over open-source security
skills**. Pashov's audit teams and Trail of Bits have published Claude Code
skills that encode best-in-class security-review methodology (per-finding
verification with gate reviews, diff-aware code analysis, etc.).
Reinventing those in-house would be wasted effort. The LI.FI value-
add is the audit history (LF-NNN corpus + Semgrep rules derived from it)
and the CI/Code-Scanning plumbing.

```
                  ┌─────────── Stage 1: deterministic ────────────┐
                  │  Slither              Semgrep (LI.FI rules)    │
                  │  (--exclude-info      (audit/knowledge/        │
                  │   --exclude-low)       semgrep/lf-*.yml)        │
                  │     │                       │                  │
                  │     ▼                       ▼                  │
                  │   slither.sarif         semgrep.sarif          │
                  └─────────────────┬─────────────────────────────┘
                                    │
   ┌──────────────────────────────  Stage 2: AI orchestration ────────────┐
   │  lifi-pr-review (claude-code-action)                                  │
   │    LI.FI layer (this repo, MIT/LGPL):                                 │
   │       • applies skip-list + waivers                                   │
   │       • injects LF-NNN corpus + by-area context                       │
   │       • normalizes ToB skills' output → curated.sarif + summary.md    │
   │                                                                       │
   │    ToB layer (vendored CC-BY-SA-4.0 at .claude/vendor/tob-skills/):   │
   │       • audit-context-building  ← bottom-up baseline understanding    │
   │       • differential-review     ← diff-scoped review (7 phases)        │
   │       • fp-check                ← per-finding TP/FP verification      │
   └─────────────────┬─────────────────────────────────────────────────────┘
                     │
                  ┌──▼── Stage 3: publish ───────────────────────┐
                  │  upload curated.sarif → Code Scanning         │
                  │  sticky PR comment with summary.md            │
                  │  status check: advisory (EXP-485 flips)       │
                  └───────────────────────────────────────────────┘
```

Per-stage detail, source, and ownership:

| Stage | Where it runs                                              | Source of truth                                       | Ticket           |
| ----- | ---------------------------------------------------------- | ----------------------------------------------------- | ---------------- |
| 1     | 2 parallel jobs in `.github/workflows/security-review.yml` | Tool releases + `audit/knowledge/semgrep/*.yml`       | EXP-480          |
| 2 (LI.FI layer)| `lifi-pr-review` job                              | `.agents/commands/lifi-pr-review.md` skill            | EXP-483          |
| 2 (ToB layer)  | Same job, invoked by the LI.FI orchestrator       | `.claude/vendor/tob-skills/` (CC-BY-SA-4.0, see NOTICE) | upstream (pinned) |
| 3     | Steps inside the `lifi-pr-review` job                      | Same workflow file                                    | EXP-483          |
| corpus| `audit/knowledge/` (committed)                             | `.agents/commands/extract-audit-knowledge.md`         | EXP-478, EXP-479 |

## Triggers

The workflow runs on every `pull_request` (opened, synchronize, reopened,
ready_for_review) that modifies files matching:

- `src/**`
- `audit/knowledge/**` (custom rule changes re-trigger so the new rules run on the same PR)

Draft PRs are skipped. The workflow is also `concurrency`-grouped per PR so
new commits cancel stale in-flight runs.

## How to read the output

Three surfaces present results:

1. **Inline annotations** in the "Files changed" tab — one per surviving
   finding at the exact line. Sourced from `curated.sarif`.
2. **A single sticky PR comment** posted by `claude-code-action` (re-edited
   on each push). Summary table + top findings + tools-that-contributed.
3. **GitHub Code Scanning Security tab** — historic view across all PRs,
   dedup'd via `partialFingerprints.primaryLocationLineHash`.

Severity mapping in the table:

| Severity | Action                                  | Status check (EXP-485) |
| -------- | --------------------------------------- | ---------------------- |
| Critical | Must fix before merge                   | fail                   |
| High     | Must fix before merge                   | fail                   |
| Medium   | Should fix; merge with reviewer sign-off | pass                   |
| Low      | Could fix; informational                | pass                   |
| Info     | FYI                                     | pass                   |

Until EXP-485 ships, the status check is **advisory** — failing means "look
at me," not "blocked from merging".

## Waiver workflow

When a finding is a confirmed false positive — repeatable, no security
impact, won't get better with rule tightening — add a waiver to
`audit/findings/waived.yml`.

### Process

1. Open a separate PR adding the waiver entry (don't waive in the same PR
   that introduced the code; reviewers should see the finding once before
   it's suppressed).
2. Fill in **all required fields**, especially `rationale` and `expires`.
3. Get approval from a member of `@smartcontract_core` or above.
4. Once merged, the next workflow run on any branch will skip the matching
   finding.

### Don't waive when …

- The rule is too noisy in general — fix the rule under
  `audit/knowledge/semgrep/` (Semgrep) or open an EXP-484 follow-up for
  Slither config tuning (or the relevant detector's exclusion at the
  `--exclude-<level>` level). Don't suppress per-finding.
- The finding is real but accepted as an admin-only risk — leave it. It's
  documented as "centralization-risk by design" elsewhere.
- The tool will probably fix this in the next release — let it.

### Quarterly review

Per the EXP-485 runbook, the security lead reviews every entry in
`waived.yml` each quarter. Expired waivers are deleted; near-expiry ones
either get extended (with fresh rationale) or removed.

## Override path (security emergency)

If a real exploit is being hot-fixed and the security review is blocking the
merge:

1. Open the PR as a **draft** first — the review is skipped on drafts (see
   Triggers), so it won't run while you prepare the hot-fix.
2. Get explicit Slack approval from `@smartcontract_core_lead` (or named
   alternate).
3. Move to ready-for-review and merge with the override label.
4. **Within 24 hours**, open the follow-up that addresses any remaining
   findings or adds a documented waiver.

This is an escape hatch, not a workflow. Three uses in a rolling 90 days
triggers a process review.

## Adding a custom Semgrep rule

New rules go under `audit/knowledge/semgrep/lf-NNN-<name>.yml`. Each rule:

- Must have a stable id (`lf-NNN-<short-name>`) cross-referencing an LF-NNN
  finding in `audit/knowledge/findings.json`.
- Must pass `semgrep --validate --config audit/knowledge/semgrep` locally
  before commit.
- Should include `# TODO(EXP-484): …` if the precision is known-low so
  EXP-484 can revisit.

See `audit/knowledge/semgrep/README.md` for the rule conventions.

## Audit-knowledge coverage (EXP-481)

Every audit listed in `audit/auditLog.json` should also have findings
extracted into `audit/knowledge/findings.json`. The `/lifi-pr-review`
pipeline (Stage 2) uses that corpus as cached context for the AI
triage — a missing audit means the security agent silently loses access
to prior findings from that report.

### How it stays in sync

When you add an audit via `/add-audit`, **Step 9** chains into
`/extract-audit-knowledge <audit_id>` automatically. The PDF, the
auditLog entry, and the corpus update all land in the same commit / PR.

Skippable for two-step workflows via `/add-audit --skip-extract` — the
skill prints a reminder to run `/extract-audit-knowledge` before
shipping.

### Checking drift manually

`script/tasks/checkAuditKnowledgeCoverage.ts` reports the current
coverage gap (which audits are in the log but missing from the corpus).
Run it locally when you want to triage the EXP-479 backfill queue:

```bash
bun script/tasks/checkAuditKnowledgeCoverage.ts
```

It's a diagnostic tool, not a CI gate — the corpus is advisory context
for the security agent, and missing entries degrade the agent's recall
rather than break correctness. Treat coverage gaps as tech debt, not
release blockers.

## Bumping the Trail of Bits skills

The ToB skills are vendored as a git submodule at
`.claude/vendor/tob-skills/` pinned to a specific SHA. To bump:

```bash
# 1. Check the upstream changelog
gh api repos/trailofbits/skills/commits --jq '.[0:10].[]|{sha, msg: .commit.message|split("\n")[0]}'

# 2. Bump to a specific SHA
cd .claude/vendor/tob-skills
git fetch origin
git checkout <new-sha>
cd -

# 3. Update the pinned SHA in NOTICE
# 4. Verify the symlinks still resolve
ls -la .claude/plugins/

# 5. Re-run the dry-run on a sample PR
#    (see "Local dry-run" section below)

# 6. Commit:
git add .claude/vendor/tob-skills NOTICE
git commit -m "chore(security-review): bump tob-skills to <new-sha-short>"
```

Bump deliberately — when there's a fix/feature we need or after a
security advisory. Not opportunistically. Major bumps (any change to
fp-check's gate count, differential-review's phase structure, or the
sub-agent interfaces) require re-measuring Stage 1's noise rate against
a sample of recent PRs to catch regressions in our false-positive rate.

## Why we don't run Aderyn

Aderyn (Cyfrin's Rust-based static analyzer) was part of Stage 1 in the
initial EXP-480 prototype but was removed on 2026-05-22 after dry-runs
on PR #1715 + #1731 showed it added only ~1 finding per PR beyond what
Slither already caught in the same code. The marginal value didn't
justify the supply-chain attack surface of the installer step and the
extra job in CI.

Slither alone covers the same detector classes (with a different
implementation), and the noise level is well-controlled by
`--exclude-informational --exclude-low`. If we want a second-opinion
pass, it belongs in EXP-486 (nightly deep scan), not per-PR Stage 1.

## Cost & runtime

| Stage | Typical runtime | Cost (per PR) |
| ----- | --------------- | ------------- |
| 1     | 1–3 min         | free (CI)     |
| 2     | 1–4 min         | $0.10–$1.60   |
| 3     | <10 s           | free          |

Stage 2 cost increased vs. the pre-refactor estimate because `fp-check`
is a per-finding invocation. The trade-off is much higher precision
(six gates vs. our previous four).

Steady-state per-PR API cost is dominated by re-reading the audit
knowledge corpus + the ToB skill files. Prompt caching brings it down
~70% in normal operation once warm.

For PRs >30 changed src/ files (rare), Stage 2 self-skips with a "PR too
large for AI triage" notice; the raw Stage 1 SARIF remains available as a
run artifact. Request a manual security review for those.

## Troubleshooting

| Symptom                                          | Cause / fix                                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| Stage 2 fails with "ANTHROPIC_API_KEY not set"  | The secret hasn't been provisioned — check repo secrets                            |
| Sticky comment isn't updating                    | `claude-code-action` checks comment id; deleting the existing comment recreates it |
| Too many findings on a small PR                  | Probably hit a noisy Slither rule. Open an EXP-484-tag issue; don't waive each one |
| Inline annotations missing but Security tab has them | Code Scanning indexing lag; usually settles within 5 min                        |
| AI triage flagged something obviously wrong      | First, check if it cites an LF-NNN — if so, the past finding's recognition_signal needs tightening. Open a follow-up PR to `audit/knowledge/findings.json`. |

## Related

- `EXP-440` — parent ticket with the full design
- `EXP-478` — `extract-audit-knowledge` skill
- `EXP-479` — corpus + seed Semgrep rules
- `EXP-480` — Stage 1 workflow
- `EXP-483` — this skill + Stages 2 + 3 workflow
- `EXP-484` — tune precision, retire waivers
- `EXP-485` — flip from advisory to enforcing
- `EXP-486` — nightly full-repo Pashov scan
- `EXP-487` — auto-generate Semgrep rules from confirmed findings
