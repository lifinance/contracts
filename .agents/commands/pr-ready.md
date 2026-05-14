---
name: pr-ready
description: Run CodeRabbit locally against the current branch and resolve findings before opening (or updating) a PR. The final step of the development workflow.
usage: /pr-ready
---

# PR Ready — Local CodeRabbit Pre-Flight

> **Usage**: `/pr-ready` (run after tests pass, before `gh pr create` or before pushing to an open PR)

## Purpose

CodeRabbit runs in our GitHub CI and routinely produces high-quality suggestions. Today, those findings only surface **after** the PR is pushed — forcing a wait-and-fix loop. This command runs the same review locally so the PR is review-ready on first push.

Goal state: by the time CI runs, CodeRabbit finds **nothing**, because everything actionable was already resolved locally.

## When to Run

- **Mandatory** as the last step before:
  - `gh pr create` (initial PR creation)
  - Pushing new commits to an already-open PR that's marked Ready for Review
- **Not** required on every local commit or while pushing draft/WIP branches.
- Applies equally to **humans and agents**. If an agent is opening or updating a PR, it must run `/pr-ready` first and act on findings (or document why they're being ignored).

## One-Time Setup (per developer machine)

CodeRabbit CLI is per-developer; no shared secrets are committed.

```bash
# Install
curl -fsSL https://cli.coderabbit.ai/install.sh | sh

# Authenticate (browser-based; token stored in ~/.config/coderabbit/)
coderabbit auth login

# Verify
coderabbit --version
```

If `coderabbit` is not on `PATH` after install, ensure `~/.local/bin` (or the path printed by the installer) is in `PATH`.

## Workflow

1. **Preconditions**
   - Branch is rebased onto / merged with latest `main` (no stale diffs).
   - Local checks pass: `bun format:fix`, `bun lint:fix`, `forge build`, relevant `forge test` / `bun test:ts` suites.
   - All intentional changes are committed (CodeRabbit reviews committed diff vs. base).

2. **Run the review**

   ```bash
   coderabbit review --base origin/main --plain
   ```

   - `--base origin/main` ensures the diff matches what GitHub CI will see.
   - `--plain` produces a stable, machine-parseable output that agents can consume.
   - First run on a branch can take a few minutes; subsequent runs on the same diff are cached.

3. **Triage findings** (agent or human)

   Group every finding into one of three buckets:

   - **Apply**: clear, safe, mechanical fixes (typos, naming, dead code, missing NatSpec tags, obvious bug fixes). Apply directly.
   - **Discuss**: judgment calls (refactors, alternative patterns, perf trade-offs). Decide explicitly — fix, defer with a follow-up issue, or document a deliberate "won't fix".
   - **Reject**: false positives or suggestions that conflict with repo conventions (`.agents/rules/`). Note the reason; if the same false positive recurs, consider tightening the rule so future runs suppress it.

   Agents: **do not silently apply non-trivial fixes.** Surface "Discuss" and "Reject" buckets to the user with a one-line rationale per item.

4. **Re-run until clean**

   After applying fixes, run `coderabbit review --base origin/main --plain` again until the output is either:
   - empty / "no findings", or
   - contains only items you've explicitly decided to defer/reject (record those in the PR description).

5. **Open or update the PR**

   - `gh pr create` for a new PR, or `git push` for updates.
   - Cloud CodeRabbit will still run in CI as a safety net — but it should now find little to nothing.

## Output / Reporting Format (for agents)

When an agent runs this command, it must report back:

```
CodeRabbit local review: <N> findings
  Applied:    <count> (list)
  Deferred:   <count> (list with rationale; tracked in PR description)
  Rejected:   <count> (list with rationale)
Re-run after fixes: <0 / <N> remaining>
```

Do not claim "PR-ready" until the re-run shows no actionable findings.

## Caveats

- The local CLI does not have 100% parity with cloud CodeRabbit (no repo-wide learnings, no PR-conversation context). Aim for "near zero" cloud findings, not exactly zero. Residual cloud findings then become high-signal.
- If `coderabbit review` itself errors (auth expired, network, rate limit), do **not** silently skip — surface the failure, fix the cause, and re-run. Do not push an "unreviewed" PR to bypass the step.
- Sensitive diffs (security fixes pre-disclosure) may legitimately skip the local CLI. Document the reason in the PR description.

## Validation Checklist

Before declaring a PR ready:

- [ ] `coderabbit review --base origin/main --plain` exit clean OR remaining findings explicitly documented in the PR body.
- [ ] All local lints/tests still pass after applied fixes.
- [ ] No `--no-verify`-style escape hatches used.
- [ ] Re-run performed after the final set of fixes.

## Related

- Final-checks rule: `.agents/rules/099-finish.md` — this command is the final step of that checklist.
- PR template: `.github/pull_request_template.md` — includes a `/pr-ready` confirmation box.
