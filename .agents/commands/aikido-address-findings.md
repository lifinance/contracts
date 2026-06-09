---
name: aikido-address-findings
description: Full Aikido triage for the current branch — scans changed files, fetches live feed issues, identifies false positives and real findings, bulk-ignores false positives via aikido_ignore_issue, applies code fixes for real findings (NoSQL injection, GH Actions template injection, vulnerable dependencies, unpinned Actions), annotates each commit with the Aikido finding ID, and optionally hands off to /create-pr. Use when Aikido comments appear on a PR, when asked to "address aikido findings", "fix aikido issues", or "triage aikido", or after finishing a feature branch before opening a PR.
usage: /aikido-address-findings [repo-name] — defaults to "contracts"
---

# Aikido Address Findings

Single entry point for all Aikido triage on the current branch. Handles both false positives (ignore + SAST context) and real findings (code fixes).

---

## Preflight — verify MCP is authenticated

Call `aikido-mcp:aikido_full_scan` with a minimal test payload:

- files: `[{ path: "test.js", content: "// test" }]`

If it fails or the tool is not found, stop:
> The Aikido MCP server is not available or not authenticated.
> Run `/aikido:setup` — get your API key from **https://app.aikido.dev → Settings → Integrations → IDE Plugins**, then restart Claude Code.

---

## Phase 1 — Collect findings

### 1.1 Get changed files

Run `git diff --name-only main...HEAD` (or `origin/main...HEAD` if the remote ref is needed) to get the list of files changed on this branch.

### 1.2 Scan changed files

Call `aikido-mcp:aikido_full_scan` with the content of every changed file. Stay within the 50-file limit — batch into multiple calls if needed.

### 1.3 Fetch live feed issues

Call `aikido-mcp:aikido_issues_list` filtered to:

- Repository: the repo name the user specified, or `contracts` by default
- Issue type: `sast`

Merge with scan results. Deduplicate by file + rule so each finding is triaged once.

---

## Phase 2 — Triage

Read `.agents/references/aikido-false-positive-catalog.md` for the full pattern catalog.

For each finding decide:

| Decision | Criteria |
|----------|----------|
| **FALSE POSITIVE** | Matches a pattern in the catalog |
| **REAL — fix** | Known fix recipe exists (see Phase 4) |
| **REAL — manual** | Real finding, no automated fix available |

Present the triage table and ask for confirmation before acting:

```
| # | Finding | Severity | File | Decision | Category |
|---|---------|----------|------|----------|----------|
| 1 | Path traversal | medium | script/deploy/tron/tronUtils.ts | FALSE POSITIVE | path_traversal_scripts |
| 2 | NoSQL injection | high | script/deploy/safe/execute-pending-timelock-tx.ts | REAL — fix | nosql_no_sanitizer |
| 3 | Template injection | critical | .github/workflows/generateContractChangelog.yml | REAL — fix | template_injection_gha |
| 4 | Unpinned Action | medium | .github/workflows/deploy-smoke-test.yml | REAL — fix | unpinned_action |
| 5 | Vulnerable dep: handlebars | critical | bun.lock | REAL — fix | vulnerable_dependency |
```

Ask: "Proceed? I'll ignore X false positives and fix Y real findings."

---

## Phase 3 — Ignore false positives

For each confirmed false positive, call `aikido-mcp:aikido_ignore_issue` with:

- `issue_id`: the ID from the feed
- `reason`: the `ignore_reason` from the catalog entry

Report which succeeded and which failed.

---

## Phase 4 — Fix real findings

Apply fixes in this order: dependencies first (least risky), then GH Actions, then source code. For each fix, commit immediately with a message that includes the Aikido finding ID.

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
