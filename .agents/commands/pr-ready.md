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

**Install** is automatic: `bun install` runs `preinstall.sh`, which installs the CLI if missing (skipped on CI). After install, you must authenticate once:

```bash
coderabbit auth login    # browser flow; token stored in ~/.config/coderabbit/
coderabbit --version     # verify
```

**Manual fallback** (if the preinstall hook didn't run, or the install failed soft):

```bash
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
coderabbit auth login
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

3. **Classify findings** (agent or human)

   Sort every finding into one of three buckets — this is classification only, **not** approval to change code:

   - **Apply-candidate**: clear, mechanical fixes (typos, naming, dead code, missing NatSpec tags, obvious bug fixes).
   - **Discuss**: judgment calls (refactors, alternative patterns, perf trade-offs).
   - **Reject**: false positives or suggestions that conflict with repo conventions (`.agents/rules/`).

4. **Apply with per-finding consent** (agent safety contract)

   Agents MUST follow this contract. The dev pushes whatever the agent commits under their name, so consent must be explicit and individually reviewable.

   For every Apply-candidate finding:

   1. **Show first, change never first.** Print a short block:
      ```
      [N/total] <file>:<line> — <one-line issue summary>
        CR says:   <≤ 80-char excerpt>
        Proposed:  <unified diff, ≤ 15 lines>
      Apply? [y / n / skip-rest]
      ```
   2. **Wait for explicit user approval** before editing. `n` and `skip-rest` are both honored without argument.
   3. On approval, edit the file, then create a **dedicated commit** with subject:
      ```
      pr-ready: <one-line issue summary> (<file>:<line>)
      ```
      and body containing the CR finding excerpt and a one-line rationale. **One finding = one commit.** Never batch multiple findings into a single commit, never amend, never squash, never rebase `pr-ready:` commits before push — the dev must be able to read `git log` and revert any single fix individually.
   4. For **Discuss** and **Reject** findings, the agent never edits code. It surfaces a one-line rationale to the user and records the decision for the final summary.

   Hard rules for agents (no exceptions, even on "trivial" fixes):

   - No silent allowlist. Even typos require approval.
   - Never use `git commit --amend`, `git rebase -i`, `git push --force`, or `--no-verify` during `/pr-ready`.
   - Never modify files outside the diff CodeRabbit reviewed.
   - If the user is unavailable / non-interactive, **stop and report** — do not infer consent.

5. **Detect repeat patterns** (the "brain")

   The skill maintains a gitignored local log at `~/.cache/lifi-contracts/pr-ready/findings.jsonl`. After classification (step 3), the agent appends one entry per finding:

   ```json
   {"date":"<ISO>","branch":"<name>","file":"<path>","category":"<CR rule id or short tag>","fingerprint":"<hash of normalized message>"}
   ```

   On each run, before applying anything, the agent checks the log for matching fingerprints. If a finding's fingerprint has appeared in **≥ 3 distinct branches**, surface it in the final summary as a *promotion candidate*:

   ```
   Repeat patterns:
     - "<short tag>" seen in 4 branches — consider promoting to a rule.
       Suggested location: .agents/rules/<NNN>-<name>.md (matching scope: <glob>)
   ```

   The agent **never** writes to `.agents/rules/` from inside `/pr-ready`. Promotion is a separate, explicit step the dev runs via `/add-new-rule`.

6. **Re-run until clean**

   After all approved fixes are applied, run `coderabbit review --base origin/main --plain` again until the output is either:
   - empty / "no findings", or
   - contains only items explicitly deferred/rejected (record those in the PR description).

7. **Open or update the PR**

   - `gh pr create` for a new PR, or `git push` for updates.
   - Cloud CodeRabbit will still run in CI as a safety net — but it should now find little to nothing.

## Output / Reporting Format (mandatory final summary)

After the re-run, the agent must print a single concise summary block. One line per applied finding linking issue → commit SHA so the dev can audit before pushing:

```
/pr-ready summary  (branch: <name>, base: origin/main)

Findings: <total>

Applied (<N>):
  <short-sha>  <file>:<line>  <one-line issue summary>
  <short-sha>  <file>:<line>  <one-line issue summary>
  ...

Deferred (<N>) — recorded in PR body:
  <file>:<line>  <one-line summary>  — <rationale>
  ...

Rejected (<N>):
  <file>:<line>  <one-line summary>  — <rationale, e.g. conflicts with rule 105-security>
  ...

Repeat patterns (<N>) — candidates for promotion via /add-new-rule:
  "<short tag>"  seen in <K> branches  — suggested scope: <glob>
  ...

Re-run status: <CLEAN | N remaining (documented)>
```

Do not claim "PR-ready" until the re-run shows no actionable findings, and do not push until the dev has reviewed this summary.

## Caveats

- The local CLI does not have 100% parity with cloud CodeRabbit (no repo-wide learnings, no PR-conversation context). Aim for "near zero" cloud findings, not exactly zero. Residual cloud findings then become high-signal.
- If `coderabbit review` itself errors (auth expired, network, rate limit), do **not** silently skip — surface the failure, fix the cause, and re-run. Do not push an "unreviewed" PR to bypass the step.
- Sensitive diffs (security fixes pre-disclosure) may legitimately skip the local CLI. Document the reason in the PR description.

## Validation Checklist

Before declaring a PR ready:

- [ ] `coderabbit review --base origin/main --plain` exit clean OR remaining findings explicitly documented in the PR body.
- [ ] Every applied fix is its own `pr-ready:` commit, visible in `git log` and individually revertable.
- [ ] No `git commit --amend`, `git rebase -i`, or `git push --force` used during the session.
- [ ] All local lints/tests still pass after applied fixes.
- [ ] No `--no-verify`-style escape hatches used.
- [ ] Re-run performed after the final set of fixes.
- [ ] Dev has reviewed the summary block before pushing.

## Related

- Final-checks rule: `.agents/rules/099-finish.md` — this command is the final step of that checklist.
- PR template: `.github/pull_request_template.md` — includes a `/pr-ready` confirmation box.
