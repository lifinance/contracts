---
name: aikido-address-findings
description: Full Aikido triage for a PR or repo. In PR scope (default) it reads the aikido-pr-checks[bot] inline review comments on the PR; in repo/single-issue scope it reads the aikido_issues_list feed. Identifies false positives and real findings, ignores false positives (by replying "@AikidoSec ignore:" on the PR comment, or via aikido_ignore_issue for feed scope), applies code fixes for real findings (NoSQL injection, GH Actions template injection, vulnerable dependencies, unpinned Actions), and optionally hands off to /create-pr. Use when Aikido comments appear on a PR, when asked to "address aikido findings", "fix aikido issues", or "triage aikido", or after finishing a feature branch before opening a PR.
usage: /aikido-address-findings [<issue-id> | all | pr] [repo-name] — scope defaults to "pr" (current branch's PR), repo defaults to the current git repo
---

# Aikido Address Findings

Single entry point for all Aikido triage. Handles both false positives (ignore + SAST context) and real findings (code fixes), scoped to the current PR, a single finding, or the whole repo.

---

## Scope — what gets triaged

The first argument selects scope (default `pr`). A second optional argument overrides the repo name (default: the current git repo).

| Argument | Scope | Source of findings |
|----------|-------|--------------------|
| _(none)_ or `pr` | Findings on the current branch's open PR | `aikido-pr-checks[bot]` inline review comments on the PR |
| `all` | Every open SAST finding in the repo | `aikido_issues_list` feed (no filter) |
| `<issue-id>` (numeric) | One specific finding | `aikido_issues_list` feed, filtered to that `issue_id` |

The two scopes use different identifiers and different ignore mechanisms: **`pr`** works off PR review-comment IDs and ignores via a GitHub comment reply; **`all`/`<issue-id>`** work off Aikido feed `issue_id`s and ignore via the MCP. They don't mix.

---

## Preflight

- **`pr` mode**: needs `gh` authenticated against the PR's repo. No MCP call required — the findings come from PR comments.
- **`all` / `<issue-id>` mode**: needs the Aikido MCP. Verify with `aikido-mcp:aikido_full_scan` on `[{ relativeFilePath: "test.js", content: "// test" }]`. If it fails or is missing, stop:
  > The Aikido MCP server is not available or not authenticated.
  > Run `/aikido:setup` — get your API key from **https://app.aikido.dev → Settings → Integrations → IDE Plugins**, then restart Claude Code.

---

## Phase 1 — Collect findings

### `pr` mode (default) — read the PR bot comments

The Aikido GitHub app (`aikido-pr-checks[bot]`) scans the PR diff and posts one **inline review comment** per finding. These are authoritative for the PR — use them, not the feed. The feed is tagged to `main` and both misses findings the PR introduces and includes `main` findings on files the PR doesn't touch.

1. **Resolve the PR.** `gh pr view --json number,url` finds the PR for the *current* branch. If it prints "no pull requests found" — you're not on the PR's head branch (e.g. testing from another branch) — ask the user for the PR number or URL; do not guess. Owner/repo come from `gh` automatically (the `origin` remote). Never hardcode the repo: this repo and its upstream share most code under **different** Aikido repo names (`contracts-tron` vs `contracts`), so querying the wrong one returns the wrong findings.
2. **Fetch the bot's findings** — they are **review comments**, not issue comments, and each finding root has `in_reply_to_id == null`:

   ```
   gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate \
     --jq '.[] | select(.user.login=="aikido-pr-checks[bot]" and .in_reply_to_id==null) | {id, path, line, body}'
   ```

   Each is one finding. Record `id` (needed to reply when ignoring), `path:line`, title + severity (first line of `body`), the `Show fix` ` ```suggestion ` block if present, and the `More info` link.
3. **Skip already-handled findings (idempotency).** Re-running must not double-post. A finding is already actioned if its thread has a reply starting with `@AikidoSec ignore:`. Collect those roots and exclude them:

   ```
   gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate \
     --jq '.[] | select(.body | startswith("@AikidoSec ignore:")) | .in_reply_to_id'
   ```

   Report excluded findings as "already ignored"; triage only the remainder.

If the bot has not commented yet (scan still running), say so and stop — do not silently fall back to the `main` feed, which reports the wrong findings.

### `all` / `<issue-id>` mode — read the feed

Call `aikido-mcp:aikido_issues_list` with issue type `sast` and the repo name. Derive the name from `gh repo view --json name -q .name` (the `origin` repo, e.g. `contracts-tron`) — don't hardcode it; the upstream shares code under the `contracts` repo name. For `<issue-id>`, keep only the finding whose `issue_id` matches the argument; if none matches, report `issue <id> not found in the feed` and stop. For `all`, keep every finding.

---

## Phase 2 — Triage

Read `.agents/references/aikido-false-positive-catalog.md` for the full pattern catalog.

Analyze **each finding individually** — don't just bucket it into a category. Read the flagged code at `<file>:<line>` (the file is local; for `pr` mode the bot comment already quotes the line and often a `Show fix` suggestion). For every finding, output this block:

> **#N — \<title>** · `<file>:<line>` · \<severity>
>
> - **Problem** — what Aikido flagged and the risk it points at, in one plain sentence (e.g. "a CLI-supplied path is read with `fs.readFileSync`, so a crafted `../` could read files outside the intended dir").
> - **Assessment** — is it actually exploitable *in this codebase*? Where does the input come from, and what's the threat model (HTTP-exposed vs internal CLI/CI, allow-listed vs free-form, sanitizer-wrapped)? Name the matching catalog pattern if it's a known false positive.
> - **If fixed** — the concrete change that would resolve it (the Phase 4 recipe, or the bot's `Show fix` suggestion). Show this **even when recommending ignore**, so the user can weigh ignore-vs-fix.
> - **Recommendation** — **Ignore** / **Fix** / **Manual review**, plus a one-line why.

Decision rule for the recommendation:

| Recommendation | When |
|----------------|------|
| **Ignore** | Matches a false-positive pattern in the catalog — not exploitable in this codebase |
| **Fix** | Real finding with a known fix recipe (Phase 4) |
| **Manual review** | Real finding with no automated fix, or a judgment call the user should make |

Then print a one-line-per-finding summary table and the confirmation prompt:

```
| # | Finding | Sev | File | Recommendation | Pattern / Recipe |
|---|---------|-----|------|----------------|------------------|
| 1 | Path traversal | med | script/tasks/foo.ts:76 | Ignore | path_traversal_scripts |
| 2 | NoSQL injection | high | script/deploy/x.ts:40 | Fix | nosql_no_sanitizer |
| 3 | Unpinned Action | high | .github/workflows/x.yml:81 | Fix | unpinned_action |
| 4 | Broad GH permissions | med | .github/workflows/y.yml:7 | Manual review | — |
```

Ask: "Proceed? I'll ignore X false positives and fix Y real findings (Z need manual review)."

If a finding looks like a false positive but matches **no** catalog pattern, recommend **Manual review** and offer `/aikido-update-false-positive-catalog` to add a pattern — never invent an ignore reason that isn't grounded in the catalog.

---

## Phase 3 — Ignore false positives

### `pr` mode — reply to the bot comment

The Aikido bot ignores a finding when it sees a reply starting with `@AikidoSec ignore:` on that finding's comment thread. Reply to each false-positive comment **that was not already excluded in Phase 1 step 3** with the catalog `ignore_reason`:

```
gh api -X POST repos/{owner}/{repo}/pulls/<N>/comments/<comment-id>/replies \
  -f body="@AikidoSec ignore: <ignore_reason from catalog>"
```

`<comment-id>` is the finding root's `id`, not its `in_reply_to_id`. This is the GitHub path; it does **not** depend on the MCP ignore permission. Report each reply URL.

### `all` / `<issue-id>` mode — ignore via MCP

For each confirmed false positive call `aikido-mcp:aikido_ignore_issue` with `issue_id` (from the feed) and `reason` (the catalog `ignore_reason`).

If it returns `400 - Feature is disabled for this workspace`, the MCP ignore permission is off for this workspace. Stop calling it, point the user to **https://app.aikido.dev/settings/integrations/ide/mcp/permissions** (or ask an Aikido admin), and output the `issue_id`s + reasons for manual ignore in the UI.

Report which succeeded and which failed.

---

## Phase 4 — Fix real findings

Apply fixes in this order: dependencies first (least risky), then GH Actions, then source code. For each fix, commit immediately with a message that includes the Aikido finding ID. In `pr` mode, the bot comment usually carries a `Show fix` ` ```suggestion ` block — use it as the starting point, but still verify it against the recipes below (the auto-suggestion is sometimes over-broad).

**Commit message format:**

```
fix(security): <short description> [aikido:<finding-id>]
```

### Category: `nosql_no_sanitizer`

MongoDB query without `{ $eq }` protection in a TypeScript script.

Fix recipe:

1. Add `mongoEq` to the import from `./shared/mongo-log-utils` (or the correct relative path to `script/deploy/shared/mongo-log-utils.ts`)
2. Wrap each bare query field value: `{ field: value }` → `{ field: mongoEq(value) }`
3. If `Filter<T>` type is needed, import it from `mongodb` and replace `Record<string, unknown>` on the query object

Example:

```typescript
// Before
collection.findOne({ contractName, network })

// After
import { mongoEq } from './shared/mongo-log-utils'
collection.findOne({ contractName: mongoEq(contractName), network: mongoEq(network) })
```

### Category: `template_injection_gha`

`${{ github.event.* }}` or other GitHub context expressions interpolated directly in a `run:` shell step.

Fix recipe:

1. Add an `env:` block to the step (or the job, if shared across steps)
2. Move the expression into the env block as a named variable
3. Replace the interpolation in the shell command with `$VAR_NAME`

Example:

```yaml
# Before
- run: echo "PR body: ${{ github.event.pull_request.body }}"

# After
- env:
    PR_BODY: ${{ github.event.pull_request.body }}
  run: echo "PR body: $PR_BODY"
```

### Category: `unpinned_action`

Third-party `uses:` reference not pinned to a commit SHA.

Fix recipe:

1. Get the SHA for the current tag: `gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq '.object.sha'` (if it's an annotated tag, follow to `.object.url` and fetch again for the commit SHA)
2. Replace `uses: owner/action@vX.Y.Z` with `uses: owner/action@<sha> # vX.Y.Z`

Example:

```yaml
# Before
uses: oven-sh/setup-bun@v1.2.2

# After
uses: oven-sh/setup-bun@f4d14e03ff726c06358e5557344e1da148b56cf7 # v1.2.2
```

### Category: `vulnerable_dependency`

CVE-linked vulnerability in an npm/bun dependency.

Fix recipe:

1. Check the Aikido finding for the safe version to upgrade to
2. Update the version in `package.json`
3. If it's a transitive dep not in `package.json` directly, add it to `overrides` (bun supports `overrides` in `package.json`)
4. Run `bun install` to regenerate `bun.lock`
5. Verify the vulnerable version is gone: `grep '<package-name>' bun.lock`

### Category: `exposed_secret_code` (hardcoded secret in source)

A real secret value hardcoded in a TypeScript or Bash file (distinct from `.env.example` placeholders, which are false positives).

Fix recipe:

1. Move the value to an environment variable: add it to `.env.example` as a placeholder, read it via `process.env.VAR_NAME` in TS or `$VAR_NAME` in Bash
2. Throw/exit clearly if the env var is missing at runtime

---

## Phase 5 — Output SAST context for the UI

For each false positive rule type, output the `sast_context` block from the catalog so the user can paste it into:
**Aikido UI → Repositories → Checks → View SAST Rules → [rule] → Custom Code Context → Scope: global**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Rule: [rule name]
Search keyword: "[keyword]"

[sast_context text from catalog]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Phase 6 — Final report

```
✓ False positives ignored: N (list each with pattern matched)
✓ Real findings fixed:     N (list each with finding ID + fix applied)
⚠ Manual review needed:   N (list each with why no auto-fix)
```

Offer: "Run `/post-pr-for-review` to post for review (if a PR already exists), or `/create-pr` if no PR exists yet."
