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

3. **Classify findings** into three buckets

   - **Auto-apply (safe)** — mechanical, behavior-preserving, low-risk fixes. **Strict allowlist** (current trial period; revisit after a few weeks of real use):
     - Typos in comments, NatSpec, log/error strings, and markdown docs.
     - Missing NatSpec tags (`@notice`, `@param`, `@return`, `@dev`) where the body is unambiguous from the function signature.
     - Removing unused imports.
     - Comment-only formatting / wording cleanups.
     - Any finding CR itself marks as `nitpick` / `style` AND that touches only comments or imports.

     **Not auto-apply** (must go through the ask path, even if CR says it's a small fix): anything that changes control flow, storage, visibility, modifiers, function signatures, return values, event signatures, constants, allowlists, or test assertions; anything in `.sol` files outside comments/imports; anything touching `src/Facets/**`, `src/Periphery/Receiver*.sol`, `src/Security/**`, or `script/deploy/**` beyond comment edits.

   - **Ask** — judgment calls. Refactors, alternative patterns, perf trade-offs, "this could be simpler", suggested renames of identifiers, any logic change, and **anything the agent is not 100% certain belongs in Auto-apply.** When in doubt, Ask — never silently promote.

   - **Reject** — false positives or suggestions that conflict with `.agents/rules/`. No edit; rationale recorded in the summary.

4. **Apply** — different rules per bucket

   **Auto-apply bucket** (no prompt; oversight is the commit log + final summary):

   1. Edit the file.
   2. Create a **dedicated commit** with subject:
      ```
      pr-ready: <one-line issue summary> (<file>:<line>)
      ```
      Body contains the CR finding excerpt + a one-line rationale. **One finding = one commit.**
   3. Do **not** push. The dev pushes after reviewing the summary.

   **Ask bucket** (per-finding consent):

   1. Print:
      ```
      [N/total] <file>:<line> — <one-line issue summary>
        CR says:   <≤ 80-char excerpt>
        Proposed:  <unified diff, ≤ 15 lines>
      Apply? [y / n / defer / skip-rest]
      ```
   2. Wait for explicit answer. `y` → edit + one-commit-per-fix (same format as Auto-apply). `n` / `defer` → record in summary (deferred with rationale). `skip-rest` → record all remaining Ask items as deferred and move to step 6.
   3. Never infer consent. If the user is non-interactive, treat every Ask item as deferred and note it in the summary.

   **Reject bucket**: no edit, record in summary.

   Hard rules (apply to **all** buckets, no exceptions):

   - One finding = one commit. Never batch.
   - Never `git commit --amend`, `git rebase -i`, `git push --force`, or `--no-verify` during `/pr-ready`. The audit trail must stay intact.
   - Never modify files outside the diff CodeRabbit reviewed.
   - Never push automatically. The dev pushes after reviewing the summary.
   - If a fix would clearly break a test or the build, do not commit — surface it as an Ask instead, even if it's in the Auto-apply allowlist.

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

After the re-run, the agent must print a single concise summary block. Auto-applied and Ask-applied fixes are listed separately so the dev can quickly verify nothing was changed without their pre-approval:

```
/pr-ready summary  (branch: <name>, base: origin/main)

Findings: <total>

Auto-applied (<N>) — review before pushing:
  <short-sha>  <file>:<line>  <one-line issue summary>
  <short-sha>  <file>:<line>  <one-line issue summary>
  ...

Ask-applied (<N>) — you approved these:
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

Quick audit:  git log --oneline origin/main..HEAD -- $(git diff --name-only origin/main..HEAD)
Revert one:   git revert <short-sha>
```

Do not claim "PR-ready" until the re-run shows no actionable findings, and do not push until the dev has reviewed this summary.

## Caveats

- The local CLI does not have 100% parity with cloud CodeRabbit (no repo-wide learnings, no PR-conversation context). Aim for "near zero" cloud findings, not exactly zero. Residual cloud findings then become high-signal.
- If `coderabbit review` itself errors (auth expired, network, rate limit), do **not** silently skip — surface the failure, fix the cause, and re-run. Do not push an "unreviewed" PR to bypass the step.
- Sensitive diffs (security fixes pre-disclosure) may legitimately skip the local CLI. Document the reason in the PR description.

## Validation Checklist

Before declaring a PR ready:

- [ ] `coderabbit review --base origin/main --plain` exit clean OR remaining findings explicitly documented in the PR body.
- [ ] Every applied fix (auto-applied or ask-applied) is its own `pr-ready:` commit, visible in `git log` and individually revertable.
- [ ] No `git commit --amend`, `git rebase -i`, or `git push --force` used during the session.
- [ ] Dev has read the **Auto-applied** section of the summary and is OK with each entry (or `git revert`-ed the ones they aren't).
- [ ] All local lints/tests still pass after applied fixes.
- [ ] No `--no-verify`-style escape hatches used.
- [ ] Re-run performed after the final set of fixes.
- [ ] Dev has reviewed the summary block before pushing.

## Related

- Final-checks rule: `.agents/rules/099-finish.md` — this command is the final step of that checklist.
- PR template: `.github/pull_request_template.md` — includes a `/pr-ready` confirmation box.
