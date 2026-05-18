---
name: pr-ready
description: Run CodeRabbit locally against the current branch and resolve findings before opening (or updating) a PR. The mandatory final step before `gh pr create` or flipping a draft PR to Ready-for-Review. Triggered automatically by the pre-PR gate hook, or invoke directly with `/pr-ready`.
usage: /pr-ready
---

# PR Ready — Local CodeRabbit Pre-Flight

> **Usage**: `/pr-ready` (run after tests pass, before `gh pr create` or before pushing to an open PR)

## Purpose

CodeRabbit runs in our GitHub CI and routinely produces high-quality suggestions. Today, those findings only surface **after** the PR is pushed — forcing a wait-and-fix loop. This command runs the same review locally so the PR is review-ready on first push.

Goal state: by the time CI runs, CodeRabbit finds **nothing**, because everything actionable was already resolved locally.

## When to Run

- **Mandatory** as the last step before:
  - `gh pr create` (initial PR creation — both draft and non-draft)
  - `gh pr ready <num>` (flipping a draft to Ready for Review)
  - Pushing new commits to an already-open PR that's marked Ready for Review
- **Not** required on every local commit or while pushing draft/WIP branches.
- Applies equally to humans and agents. The pre-PR gate hook (`~/.claude/scripts/pr-ready-gate.py`, shipped in `.claude/scripts/pr-ready-gate.py`) blocks agent-issued `gh pr create` / `gh pr ready` until this skill has been run-and-cleared on the current commit.

## One-Time Setup (per developer machine)

CodeRabbit CLI is per-developer; no shared secrets are committed.

### 1. Install (automatic on `bun install`)

`bun install` runs `preinstall.sh`, which installs the CLI **only if it's not already on `PATH`** (skipped on CI). If you already have a `coderabbit` binary — newer, older, or different — `preinstall.sh` leaves it alone; you own your version. Verify:

```bash
coderabbit --version
```

#### What `preinstall.sh` does when it installs

When the CLI is missing, the script does **not** use upstream's `curl … | sh` flow (which fetches `latest` and performs no integrity check). Instead it:

1. Resolves your platform → `darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64`.
2. Downloads the pinned release artifact directly: `https://cli.coderabbit.ai/releases/<PINNED_VERSION>/coderabbit-<platform>.zip`.
3. Verifies the zip's SHA-256 against a hardcoded per-platform constant in `preinstall.sh`. **Aborts** (with recovery instructions) on mismatch — does not extract or install.
4. Extracts the single `coderabbit` binary to `~/.local/bin` and `chmod +x` it.

This matches the org policy of pinning + checksum-verifying anything we download in CI / setup scripts (same principle as SHA-pinned GitHub Action versions).

#### Manual fallback

If the preinstall hook didn't run for some reason, install the **same pinned version** manually:

```bash
PIN=$(grep '^CODERABBIT_PINNED_VERSION=' preinstall.sh | cut -d'"' -f2)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in arm64|aarch64) ARCH=arm64 ;; *) ARCH=x64 ;; esac
URL="https://cli.coderabbit.ai/releases/${PIN}/coderabbit-${OS}-${ARCH}.zip"
curl -fsSL "$URL" -o /tmp/coderabbit.zip
shasum -a 256 /tmp/coderabbit.zip   # compare to the matching constant in preinstall.sh
unzip -o /tmp/coderabbit.zip -d ~/.local/bin/
chmod +x ~/.local/bin/coderabbit
```

If `coderabbit` is still not on `PATH` after install, ensure `~/.local/bin` is in `PATH` (`echo $PATH`, then add to your `~/.zshrc` / `~/.bashrc`).

#### Bumping the CodeRabbit pin

Bump deliberately — when there's a fix/feature you need or after a security advisory. Not opportunistically. Procedure:

```bash
# 1. Find the new version
curl -fsSL https://cli.coderabbit.ai/releases/latest/VERSION

# 2. Compute SHA-256 for all 4 platforms (run from any machine with curl + shasum)
for plat in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
  URL="https://cli.coderabbit.ai/releases/<NEW_VERSION>/coderabbit-${plat}.zip"
  printf "%-16s  " "$plat"
  curl -fsSL "$URL" -o "/tmp/cr-${plat}.zip" && shasum -a 256 "/tmp/cr-${plat}.zip" | awk '{print $1}'
done
```

Then update `CODERABBIT_PINNED_VERSION` and the four hashes in `_coderabbit_expected_sha256` in `preinstall.sh`. Commit as a single change. Don't bundle the bump with unrelated work.

### 2. Authenticate (one-time, browser-based)

The CLI piggybacks on the same CodeRabbit account that reviews our PRs in CI. **Prerequisite**: your GitHub account must already be a member of the `lifinance` GitHub org (which is where the CodeRabbit app is installed). If you can view CodeRabbit's reviews on our PRs in the GitHub UI, you're good.

Run:

```bash
coderabbit auth login
```

This is a standard OAuth device flow:

1. The CLI prints a one-time code and a URL (e.g. `https://app.coderabbit.ai/login/cli?code=ABCD-1234`) and opens your default browser. If the browser doesn't open automatically, copy the URL manually.
2. In the browser, **sign in with GitHub** (use the same GitHub identity that has access to `lifinance/contracts`). If you've never used CodeRabbit's web UI before, you may be prompted to create an account / accept the org invite first — accept, then re-run `coderabbit auth login`.
3. Confirm that the code shown in the browser matches the code printed by the CLI, then click **Authorize**.
4. The CLI prints `Authenticated as <github-handle>` and writes a token to `~/.config/coderabbit/` (chmod 600). Don't commit or copy this file — it's tied to your personal account.

Verify:

```bash
coderabbit auth status     # prints your handle + token expiry
coderabbit review --help   # confirms the subcommand is available
```

### 3. Troubleshooting auth

| Symptom | Likely cause | Fix |
|---|---|---|
| `coderabbit auth login` says "no access" or "subscription required" | Your GitHub account isn't recognized as a member of an org with a CodeRabbit seat | Ask `#dev-sc-review` (or whoever manages the CodeRabbit subscription) to grant you a seat; then re-run. |
| Browser opens to a 404 / blank page | Stale install or you're behind a proxy that blocks `app.coderabbit.ai` | Re-run `bun install` (re-fetches the pinned, checksum-verified binary per the *One-time setup* steps above) and retry; if corporate proxy, allowlist `*.coderabbit.ai`. |
| `coderabbit auth status` shows expired | Tokens rotate periodically | Re-run `coderabbit auth login`. |
| Multiple GitHub accounts on the machine | Browser signs in with the wrong one | Open the auth URL in a private/incognito window and sign in with the correct GitHub account. |

If none of those help, capture the full CLI output (`coderabbit auth login -v` if the flag exists) and ask in `#dev-sc-review` — first person through onboarding documents the gap, then update this section.

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

7. **Clear the gate marker**

   Once the re-run is clean (or only documented-deferred items remain), write the gate-clear marker so the PR-creation hook stops blocking:

   ```bash
   gitdir=$(git rev-parse --git-dir)
   mkdir -p "$gitdir"
   touch "$gitdir/PR_READY_OK"
   ```

   The pre-PR gate (`.claude/scripts/pr-ready-gate.py`, or `~/.claude/scripts/pr-ready-gate.py` for the user-installed copy) requires this marker's mtime to be newer than `HEAD`'s commit timestamp; any new commit after this point re-arms the gate and the skill must be re-run.

8. **Open or update the PR**

   - `gh pr create` for a new PR, `gh pr ready <num>` to flip a draft, or `git push` for updates.
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
Gate marker:    written to <gitdir>/PR_READY_OK at <ISO>

Quick audit:  git log --oneline origin/main..HEAD -- $(git diff --name-only origin/main..HEAD)
Revert one:   git revert <short-sha>
```

Do not claim "PR-ready" until the re-run shows no actionable findings, and do not push until the dev has reviewed this summary.

## Caveats

- The local CLI does not have 100% parity with cloud CodeRabbit (no repo-wide learnings, no PR-conversation context). Aim for "near zero" cloud findings, not exactly zero. Residual cloud findings then become high-signal.
- If `coderabbit review` itself errors (auth expired, network, rate limit), do **not** silently skip — surface the failure, fix the cause, and re-run. Do not push an "unreviewed" PR to bypass the step.
- Sensitive diffs (security fixes pre-disclosure) may legitimately skip the local CLI. Document the reason in the PR description and bypass the gate explicitly via `PR_READY_OK=1 gh pr create …`.

## Validation Checklist

Before declaring a PR ready:

- [ ] `coderabbit review --base origin/main --plain` exit clean OR remaining findings explicitly documented in the PR body.
- [ ] Every applied fix (auto-applied or ask-applied) is its own `pr-ready:` commit, visible in `git log` and individually revertable.
- [ ] No `git commit --amend`, `git rebase -i`, or `git push --force` used during the session.
- [ ] Dev has read the **Auto-applied** section of the summary and is OK with each entry (or `git revert`-ed the ones they aren't).
- [ ] All local lints/tests still pass after applied fixes.
- [ ] No `--no-verify`-style escape hatches used.
- [ ] Re-run performed after the final set of fixes.
- [ ] Gate marker `$(git rev-parse --git-dir)/PR_READY_OK` exists and is newer than `HEAD`.
- [ ] Dev has reviewed the summary block before pushing.

## Related

- Final-checks rule: `.agents/rules/099-finish.md` — this command is the final step of that checklist.
- PR template: `.github/pull_request_template.md` — includes a `/pr-ready` confirmation box.
- Pre-PR gate hook: `.claude/scripts/pr-ready-gate.py` (also installed at `~/.claude/scripts/pr-ready-gate.py` as a PreToolUse hook on Bash; blocks `gh pr create` / `gh pr ready` until the marker file is current).
- Global rule: `~/.claude/CLAUDE.md` — "PR creation workflow" section.
