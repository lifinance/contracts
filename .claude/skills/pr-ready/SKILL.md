---
name: pr-ready
description: Run CodeRabbit locally against the current branch and resolve findings before opening (or updating) a PR. The mandatory final step before `gh pr create` or flipping a draft PR to Ready-for-Review. Triggered automatically by the pre-PR gate hook, or invoke directly with `/pr-ready`.
usage: /pr-ready
---

# PR Ready — Local CodeRabbit Pre-Flight (global)

> **Usage**: `/pr-ready` (run after tests pass, before `gh pr create` or before flipping a draft to Ready for Review)

> **Note on scope**: this is the **global** copy of the skill. The canonical, repo-specific version lives in `lifinance/contracts` at `.agents/commands/pr-ready.md` (with project-specific install/preinstall details, rules cross-links, and PR-template integration). When running inside a checkout that ships its own `pr-ready` skill/command, prefer that project copy. This global copy is the fallback for every other repo.

## Purpose

CodeRabbit runs in GitHub CI and routinely produces high-quality suggestions. Today, those findings only surface **after** the PR is pushed — forcing a wait-and-fix loop. This command runs the same review locally so the PR is review-ready on first push.

Goal state: by the time CI runs, CodeRabbit finds **nothing**, because everything actionable was already resolved locally.

## When to Run

- **Mandatory** as the last step before:
  - `gh pr create` (initial PR creation — both draft and non-draft)
  - `gh pr ready <num>` (flipping a draft to Ready for Review)
  - Pushing new commits to an already-open PR that's marked Ready for Review
- **Not** required on every local commit or while pushing draft/WIP branches.
- Applies equally to humans and agents. The pre-PR gate hook (`~/.claude/scripts/pr-ready-gate.py`) will block agent-issued `gh pr create` / `gh pr ready` until this skill has been run-and-cleared on the current commit.

## One-Time Setup (per developer machine)

CodeRabbit CLI is per-developer; no shared secrets are committed.

### 1. Install the CLI

Recommended (matches LI.FI policy of pinning + checksum-verifying anything we download): use the contracts repo's `preinstall.sh` flow, which downloads a pinned release artifact and verifies its SHA-256 before extracting. Inside a contracts checkout, simply run `bun install` once.

Outside the contracts checkout (e.g. fresh repo where you still want the gate to clear), install the upstream CLI:

```bash
curl -fsSL https://cli.coderabbit.ai/install.sh | sh
coderabbit --version
```

> **Note**: the upstream installer fetches `latest` and performs no integrity check. Prefer the contracts-repo flow for daily use; reserve the `curl … | sh` form for one-off bootstrapping.

If `coderabbit` is not on `PATH` after install, ensure `~/.local/bin` is in `PATH` (`echo $PATH`, add to `~/.zshrc` / `~/.bashrc` if missing).

### 2. Authenticate (one-time, browser-based)

The CLI piggybacks on the same CodeRabbit account that reviews LI.FI PRs in CI. **Prerequisite**: your GitHub account must already be a member of the `lifinance` GitHub org (which is where the CodeRabbit app is installed). If you can view CodeRabbit's reviews on `lifinance/*` PRs in the GitHub UI, you're good.

```bash
coderabbit auth login
```

Standard OAuth device flow:

1. The CLI prints a one-time code and a URL (e.g. `https://app.coderabbit.ai/login/cli?code=ABCD-1234`) and opens your default browser.
2. Sign in with GitHub (same identity that has access to `lifinance/contracts`).
3. Confirm the code in the browser matches the code printed by the CLI, then click **Authorize**.
4. CLI prints `Authenticated as <github-handle>` and writes a token to `~/.config/coderabbit/` (chmod 600). Don't commit or copy this file — it's tied to your personal account.

Verify:

```bash
coderabbit auth status     # prints your handle + token expiry
coderabbit review --help   # confirms the subcommand is available
```

### 3. Troubleshooting auth

| Symptom | Likely cause | Fix |
|---|---|---|
| `coderabbit auth login` says "no access" or "subscription required" | Your GitHub account isn't recognized as a member of an org with a CodeRabbit seat | Ask `#dev-sc-review` (or whoever manages the subscription) to grant you a seat; re-run. |
| Browser opens to a 404 / blank page | Stale install or proxy blocks `app.coderabbit.ai` | Reinstall and retry; if corporate proxy, allowlist `*.coderabbit.ai`. |
| `coderabbit auth status` shows expired | Tokens rotate periodically | Re-run `coderabbit auth login`. |
| Multiple GitHub accounts on the machine | Browser signs in with the wrong one | Open the auth URL in a private/incognito window with the correct GitHub account. |

## Workflow

1. **Preconditions**
   - Branch is rebased onto / merged with latest base (no stale diffs).
   - Local checks pass (project-specific: lint, format, build, relevant tests).
   - All intentional changes are committed (CodeRabbit reviews committed diff vs. base).

2. **Run the review**

   ```bash
   coderabbit review --base origin/main --plain
   ```

   - `--base origin/main` ensures the diff matches what GitHub CI will see. Swap for the actual base branch (`origin/develop`, `origin/master`, …) if the repo doesn't use `main`.
   - `--plain` produces a stable, machine-parseable output that agents can consume.
   - First run on a branch can take a few minutes; subsequent runs on the same diff are cached.

3. **Classify findings** into three buckets

   - **Auto-apply (safe)** — mechanical, behavior-preserving, low-risk fixes. Strict allowlist (trial period; tighten/loosen based on real-use feedback):
     - Typos in comments, doc-strings, log/error strings, markdown docs.
     - Missing doc-comment tags (`@param`, `@return`, `@notice`, `@dev`, JSDoc equivalents) where the body is unambiguous from the function signature.
     - Removing unused imports.
     - Comment-only formatting / wording cleanups.
     - Any finding CR marks as `nitpick` / `style` AND that touches only comments or imports.

     **Not auto-apply** (must go through the Ask path, even if CR calls it small): anything that changes control flow, storage, visibility, modifiers, function signatures, return values, event signatures, constants, allowlists, or test assertions; anything in source files outside comments/imports; anything in security-sensitive paths (the contracts repo lists these explicitly under `src/Facets/**`, `src/Periphery/Receiver*.sol`, `src/Security/**`, `script/deploy/**` — apply the same caution to equivalent paths in other repos).

   - **Ask** — judgment calls. Refactors, alternative patterns, perf trade-offs, "this could be simpler", renames, any logic change, and **anything the agent is not 100% certain belongs in Auto-apply.** When in doubt, Ask — never silently promote.

   - **Reject** — false positives or suggestions that conflict with the repo's rules (`.agents/rules/`, `.cursor/rules/`, `CLAUDE.md`, etc.). No edit; rationale recorded in the summary.

4. **Apply** — different rules per bucket

   **Auto-apply bucket** (no per-fix prompt; oversight is the commit log + final summary):

   1. Edit the file.
   2. Create a **dedicated commit** with subject:

      ```text
      pr-ready: <one-line issue summary> (<file>:<line>)
      ```

      Body contains the CR finding excerpt + a one-line rationale. **One finding = one commit.**
   3. Do **not** push. The dev pushes after reviewing the summary.

   **Ask bucket** (per-finding consent):

   1. Print:

      ```text
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

5. **Detect repeat patterns** (cross-branch)

   The skill maintains a gitignored local log at `~/.cache/lifi/pr-ready/findings.jsonl`. After classification (step 3), append one entry per finding:

   ```json
   {"date":"<ISO>","repo":"<owner/repo>","branch":"<name>","file":"<path>","category":"<CR rule id or short tag>","fingerprint":"<hash of normalized message>"}
   ```

   Before applying anything, check the log for matching fingerprints. If a fingerprint has appeared in **≥ 3 distinct branches**, surface it in the final summary as a *promotion candidate*:

   ```text
   Repeat patterns:
     - "<short tag>" seen in 4 branches — consider promoting to a project rule.
       Suggested location: .agents/rules/<NNN>-<name>.md (or equivalent for the repo)
   ```

   Never write to repo rules files from inside `/pr-ready`. Promotion is a separate, explicit step.

6. **Re-run until clean**

   After all approved fixes are applied, re-run `coderabbit review --base origin/main --plain` until the output is either:
   - empty / "no findings", or
   - contains only items explicitly deferred/rejected (record those in the PR description).

7. **Clear the gate marker**

   Once the re-run is clean (or only documented-deferred items remain), write the gate-clear marker so the PR-creation hook stops blocking:

   ```bash
   gitdir=$(git rev-parse --git-dir)
   mkdir -p "$gitdir"
   touch "$gitdir/PR_READY_OK"
   ```

   The pre-PR gate (`~/.claude/scripts/pr-ready-gate.py`) requires this marker's mtime to be newer than `HEAD`'s commit timestamp; any new commit after this point re-arms the gate and the skill must be re-run.

8. **Open or update the PR**

   `gh pr create` for a new PR, `gh pr ready <num>` to flip a draft, or `git push` for updates. Cloud CodeRabbit will still run in CI as a safety net — but it should now find little to nothing.

## Output / Reporting Format (mandatory final summary)

After the re-run, print a single concise summary block. Auto-applied and Ask-applied fixes are listed separately so the dev can verify nothing was changed without their pre-approval:

```text
/pr-ready summary  (repo: <owner/repo>, branch: <name>, base: <base>)

Findings: <total>

Auto-applied (<N>) — review before pushing:
  <short-sha>  <file>:<line>  <one-line issue summary>
  ...

Ask-applied (<N>) — you approved these:
  <short-sha>  <file>:<line>  <one-line issue summary>
  ...

Deferred (<N>) — recorded in PR body:
  <file>:<line>  <one-line summary>  — <rationale>
  ...

Rejected (<N>):
  <file>:<line>  <one-line summary>  — <rationale>
  ...

Repeat patterns (<N>) — candidates for promotion:
  "<short tag>"  seen in <K> branches  — suggested scope: <glob>
  ...

Re-run status: <CLEAN | N remaining (documented)>
Gate marker:    written to <gitdir>/PR_READY_OK at <ISO>

Quick audit:  git log --oneline <base>..HEAD -- $(git diff --name-only <base>..HEAD)
Revert one:   git revert <short-sha>
```

Do not claim "PR-ready" until the re-run shows no actionable findings, and do not push until the dev has reviewed this summary.

## Caveats

- The local CLI does not have 100% parity with cloud CodeRabbit (no repo-wide learnings, no PR-conversation context). Aim for "near zero" cloud findings, not exactly zero. Residual cloud findings then become high-signal.
- If `coderabbit review` itself errors (auth expired, network, rate limit), do **not** silently skip — surface the failure, fix the cause, and re-run. Do not push an "unreviewed" PR to bypass the step.
- Sensitive diffs (security fixes pre-disclosure) may legitimately skip the local CLI. Document the reason in the PR description and bypass the gate explicitly via `PR_READY_OK=1 gh pr create …`.

## Validation Checklist

Before declaring a PR ready:

- [ ] `coderabbit review --base <base> --plain` exit clean OR remaining findings explicitly documented in the PR body.
- [ ] Every applied fix is its own `pr-ready:` commit, visible in `git log` and individually revertable.
- [ ] No `git commit --amend`, `git rebase -i`, or `git push --force` used during the session.
- [ ] Dev has read the **Auto-applied** section of the summary and is OK with each entry (or `git revert`-ed the ones they aren't).
- [ ] All local lints/tests still pass after applied fixes.
- [ ] No `--no-verify`-style escape hatches used.
- [ ] Re-run performed after the final set of fixes.
- [ ] Gate marker `$(git rev-parse --git-dir)/PR_READY_OK` exists and is newer than `HEAD`.
- [ ] Dev has reviewed the summary block before pushing.

## Related

- Pre-PR gate hook: `~/.claude/scripts/pr-ready-gate.py` (PreToolUse hook on Bash; blocks `gh pr create` / `gh pr ready` until the marker file is current).
- Global rule: `~/.claude/CLAUDE.md` — "PR creation workflow" section.
- Project canonical version (contracts): `.agents/commands/pr-ready.md` in `lifinance/contracts`.
