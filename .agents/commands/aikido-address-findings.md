---
name: aikido-address-findings
description: Triages Aikido findings on the current branch's PR (aikido-pr-checks[bot] comments, default) or the repo feed (`all` / an issue ID) — ignores catalog false positives and fixes real findings after the user confirms. Use for "address aikido findings", "triage aikido", or when Aikido comments on a PR.
usage: /aikido-address-findings [<issue-id> | all | pr] [repo-name] — scope defaults to "pr" (current branch's PR), repo defaults to the current git repo
---

# Aikido Address Findings

## Scope

| Argument               | Scope                                | Source of findings                                     |
| ---------------------- | ------------------------------------ | ------------------------------------------------------ |
| _(none)_ or `pr`       | Findings on the current branch's PR  | `aikido-pr-checks[bot]` inline review comments          |
| `all`                  | Every open SAST finding in the repo  | `aikido_issues_list` feed                              |
| `<issue-id>` (numeric) | One finding                          | `aikido_issues_list` feed, filtered to that `issue_id` |

`pr` works off PR review-comment IDs and ignores via a GitHub reply; `all`/`<issue-id>` work off feed `issue_id`s and ignore via the MCP. They don't mix.

Never hardcode the repo name: this repo and its `contracts-tron` fork share most code under **different** Aikido repo names, so the wrong one returns the wrong findings.

## Preflight

- **`pr`**: needs `gh` authenticated; no MCP call.
- **`all` / `<issue-id>`**: needs the Aikido MCP. Probe with `aikido-mcp:aikido_full_scan` on `[{ relativeFilePath: "test.js", content: "// test" }]`. On failure, stop:
  > The Aikido MCP server is not available or not authenticated.
  > Run `/aikido:setup` — get your API key from **https://app.aikido.dev → Settings → Integrations → IDE Plugins**, then restart Claude Code.

## Phase 1 — Collect findings

### `pr` mode — PR bot comments

The bot's inline review comments are authoritative for the PR. Don't use the feed: it is tagged to `main`, so it misses findings the PR introduces and includes `main` findings on untouched files.

1. **Resolve the PR** with `gh pr view --json number,url`. If "no pull requests found" (not on the PR's head branch), ask for the PR number or URL — don't guess.
2. **Fetch findings** — review comments (not issue comments) whose root has `in_reply_to_id == null`:

   ```bash
   gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate \
     --jq '.[] | select(.user.login=="aikido-pr-checks[bot]" and .in_reply_to_id==null) | {id, path, line, body}'
   ```

   Record `id` (needed to reply), `path:line`, title + severity (first line of `body`), the `Show fix` ` ```suggestion ` block if present, and the `More info` link.
3. **Skip already-ignored findings** so re-runs don't double-post — exclude roots that already have an `@AikidoSec ignore:` reply, and report them as "already ignored":

   ```bash
   gh api repos/{owner}/{repo}/pulls/<N>/comments --paginate \
     --jq '.[] | select(.body | startswith("@AikidoSec ignore:")) | .in_reply_to_id'
   ```

If the bot hasn't commented yet (scan still running), say so and stop — never fall back to the `main` feed.

### `all` / `<issue-id>` mode — feed

`aikido-mcp:aikido_issues_list` with issue type `sast` and the repo name from the `repo-name` argument if given, else `gh repo view --json name -q .name`. For `<issue-id>`, keep only the matching `issue_id`; if none, report `issue <id> not found in the feed` and stop.

## Phase 2 — Triage

Use the pattern catalog `.agents/references/aikido-false-positive-catalog.md`. Analyze each finding individually: read the flagged code at `<file>:<line>` and output:

> **#N — \<title>** · `<file>:<line>` · \<severity>
>
> - **Problem** — what Aikido flagged and the risk, in one plain sentence.
> - **Assessment** — exploitable _in this codebase_? Input source and threat model (HTTP-exposed vs internal CLI/CI, allow-listed vs free-form, sanitizer-wrapped). Name the matching catalog pattern if it's a known false positive.
> - **If fixed** — the concrete change (Phase 4 recipe or the bot's `Show fix`), shown **even when recommending ignore** so the user can weigh it.
> - **Recommendation** — **Ignore** (matches a catalog pattern) / **Fix** (real, has a Phase 4 recipe) / **Manual review** (real with no recipe, or a judgment call), plus a one-line why.

A likely false positive that matches **no** catalog pattern gets **Manual review** plus an offer of `/aikido-update-false-positive-catalog` — never invent an ignore reason not grounded in the catalog.

Then print a summary table and ask for confirmation:

```text
| # | Finding | Sev | File | Recommendation | Pattern / Recipe |
|---|---------|-----|------|----------------|------------------|
| 1 | Path traversal | med | script/tasks/foo.ts:76 | Ignore | path_traversal_scripts |
```

"Proceed? I'll ignore X false positives and fix Y real findings (Z need manual review)."

## Phase 3 — Ignore false positives

### `pr` mode — reply to the bot comment

The bot ignores a finding when its thread gets a reply starting with `@AikidoSec ignore:`. For each confirmed false positive not excluded in Phase 1:

```bash
gh api -X POST repos/{owner}/{repo}/pulls/<N>/comments/<comment-id>/replies \
  -f body="@AikidoSec ignore: <ignore_reason from catalog>"
```

`<comment-id>` is the root's `id`, not its `in_reply_to_id`. This path doesn't need the MCP ignore permission. Report each reply URL.

### `all` / `<issue-id>` mode — MCP

`aikido-mcp:aikido_ignore_issue` with `issue_id` and `reason` (the catalog `ignore_reason`). On `400 - Feature is disabled for this workspace`, stop calling it, point the user to **https://app.aikido.dev/settings/integrations/ide/mcp/permissions** (or an Aikido admin), and output the `issue_id`s + reasons for manual ignore in the UI. Report successes and failures.

## Phase 4 — Fix real findings

Order: dependencies, then GH Actions, then source code. Commit each fix immediately:

```text
fix(security): <short description> [aikido:<finding-id>]
```

In `pr` mode, start from the bot's `Show fix` suggestion but verify it against these recipes — it is sometimes over-broad.

- **`nosql_no_sanitizer`** (MongoDB query without `$eq` protection in TS): import `mongoEq` from `script/deploy/shared/mongo-log-utils.ts` (correct relative path) and wrap each bare value — `{ network }` → `{ network: mongoEq(network) }`. If a `Filter<T>` type is needed, import it from `mongodb` in place of `Record<string, unknown>`.
- **`template_injection_gha`** (`${{ github.event.* }}` etc. in a `run:` step): move the expression into the step's (or job's) `env:` block and reference `$VAR_NAME` in the shell.
- **`unpinned_action`**: `gh api repos/<owner>/<repo>/git/refs/tags/<tag> --jq '.object.sha'` (annotated tag → follow `.object.url` for the commit SHA), then `uses: owner/action@<sha> # vX.Y.Z`.
- **`vulnerable_dependency`**: bump to the safe version from the finding in `package.json` (transitive → `overrides`, which bun supports), run `bun install`, confirm the vulnerable version is gone from `bun.lock`.
- **`exposed_secret_code`** (real secret hardcoded in TS/Bash, not an `.env.example` placeholder): move it to an env var with a placeholder in `.env.example`; fail clearly when it's missing at runtime.

## Phase 5 — SAST context for the UI

For each false-positive rule type, output the catalog's `sast_context` for the user to paste into **Aikido UI → Repositories → Checks → View SAST Rules → [rule] → Custom Code Context → Scope: global**:

```text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Rule: [rule name]
Search keyword: "[keyword]"

[sast_context text from catalog]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Phase 6 — Final report

```text
✓ False positives ignored: N (each with pattern matched)
✓ Real findings fixed:     N (each with finding ID + fix applied)
⚠ Manual review needed:   N (each with why no auto-fix)
```

Offer `/post-pr-for-review` if a PR exists, else `/create-pr`.
