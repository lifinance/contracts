---
name: aikido-add-sast-context
description: Triage Aikido SAST false positives for this repo. Fetches live issues via aikido_issues_list, bulk-ignores known false positives via aikido_ignore_issue with precise reasons, and produces ready-to-paste custom SAST context text per rule for the Aikido UI (prevents re-occurrence on future PRs). Use when Aikido PR scans flag issues in script/, tasks/, or .claude/ as vulnerabilities; when clearing the false positive backlog; or when asked to "add SAST context", "triage aikido issues", or "ignore aikido false positives".
usage: /aikido-add-sast-context [repo-name] — defaults to "contracts"
---

# Aikido SAST Context — Triage & Context Workflow

Two outputs:

1. **Automated**: bulk-ignore confirmed false positives via `aikido-mcp:aikido_ignore_issue`
2. **Manual guidance**: ready-to-paste custom SAST context per rule for the Aikido UI

The Aikido MCP has no API to write custom SAST context — that step requires the UI. This skill handles everything it can automate and provides exact text for the rest.

---

## Preflight — verify MCP is available and authenticated

Call `aikido-mcp:aikido_full_scan` with a minimal test payload:

- files: `[{ path: "test.js", content: "// test" }]`

**If it succeeds**: proceed to Phase 1.

**If it fails or the tool is not found**: stop and tell the user:

> The Aikido MCP server is not available or not authenticated.
> Run `/aikido:setup` to configure it — get your API key from:
> **https://app.aikido.dev → Settings → Integrations → IDE Plugins**
> Then restart Claude Code so the MCP server picks up the new key.

---

## Phase 1 — Fetch and triage

### 1.1 Fetch SAST issues

Call `aikido-mcp:aikido_issues_list` filtered to:

- Repository: the repo name the user specified, or `contracts` by default
- Issue type: `sast`

### 1.2 Categorize each issue

Read `.agents/references/aikido-false-positive-catalog.md` — it contains the full pattern catalog with matching criteria, ignore reasons, and SAST context text.

Match each issue against the catalog. For each issue decide:

| Decision | Criteria |
|----------|----------|
| IGNORE | Matches a known false positive pattern |
| MANUAL REVIEW | Uncertain — no clear pattern match |
| LEGITIMATE | Clearly real finding — leave in feed |

### 1.3 Show triage table before acting

Present this table and ask for confirmation:

```
| # | Issue title | Severity | File | Decision | Pattern |
|---|-------------|----------|------|----------|---------|
| 1 | Path traversal | medium | script/deploy/tron/tronUtils.ts | IGNORE | path_traversal_scripts |
| 2 | NoSQL injection | high | script/deploy/safe/execute-pending-timelock-tx.ts | IGNORE | nosql_internal_scripts |
| 3 | Template injection in GH Actions | critical | .github/workflows/... | MANUAL REVIEW | (no match) |
```

Ask: "Proceed with ignoring the X false positives? I'll leave the Y unmatched issues untouched."

---

## Phase 2 — Ignore confirmed false positives

For each confirmed false positive call `aikido-mcp:aikido_ignore_issue` with:

- `issue_id`: the ID from `aikido_issues_list`
- `reason`: the `ignore_reason` from the catalog entry for the matched pattern

Report which succeeded and which failed.

---

## Phase 3 — Custom SAST context for the UI

For each rule type that had false positives, output the `sast_context` block from the catalog:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Rule: [rule name]
UI: Repositories → Checks → View SAST Rules → search "[keyword]" → Custom Code Context
Scope: global

[sast_context text from catalog]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

---

## Phase 4 — Final report

Summarize: issues ignored / issues for manual review / rules needing UI context.
