---
name: add-audit
description: Add an audit report to the audit log by parsing a pasted PDF file
usage: /add-audit
---

# Add Audit Report Command

> **Usage**: `/add-audit` (then paste the PDF file into the chat)

Extract metadata from the pasted report, save the PDF to `audit/reports/`, then add the entry to
`audit/auditLog.json` — the log is written only once the PDF is in place. No helper scripts:
extract, validate, and edit `audit/auditLog.json` directly. Log structure and required fields
are owned by `.agents/rules/501-audits.md`.

## Extraction

### Contracts and versions

- Look in title, header, "Scope", "Contracts Audited", "Subject".
- No version in the report → check the `@custom:version` tag in `src/`, or ask.
- Verify each contract exists in `src/` (Facets, Periphery, Helpers, Libraries, Security) and the
  version matches its `@custom:version`.
- "ReAudit" / "Re-Audit" in the title → re-audit (version may be same or updated); "PreComp",
  "Comp" → comprehensive audit covering multiple contracts.

### Auditor

Known mappings (`auditedBy` → `auditorGitHandle`; check `audit/auditLog.json` for others):

- Sujith Somraaj → "Sujith Somraaj (individual security researcher)" → `sujithsomraaj`
- Cantina → "Cantina" or "Cantina (security firm)" → `cantinaxyz`
- Burra Security → "Burra Security" → `burrasec`

Format: individual "Name (individual security researcher)"; firm "Firm Name" or "Firm Name
(security firm)". No GitHub handle found → `"n/a"`.

### Date

Convert to `DD.MM.YYYY` or `YYYY-MM-DD`, consistent with existing entries. Prefer the date near
"completed" / "audit date". Sanity-check: not in the future, typically within the last 2 years.

### Commit hash

- 40-hex SHA, often near "Commit:" / "SHA:" or in an appendix; it may be a link in the PDF.
- Short hash → `git rev-parse <short-hash>`, else
  `gh api repos/<repo>/commits/<short-hash> --jq .sha` (repo from the PDF, default
  `lifinance/contracts`), else ask the user for the full hash or commit URL.
- None → `"n/a"` with an explanation, e.g. "n/a (This is a forked contract that was audited for
  [project])", "n/a (one deployed contract instance was audited)", "n/a (audited deployed
  version)".
- Show the hash as a clickable `https://github.com/lifinance/contracts/commit/<hash>` link and
  ask the user to confirm it — a wrong hash pins the audit to a tree that was never audited.
  Skip for "n/a".

**Post-remediation ([CONV:AUDIT-PIN]):** `auditCommitHash` = scope commit **A** from the report;
if findings were fixed afterwards, also set `finalCommitHash` = commit **D** the auditor signed
off on. Ask the user for D when the PDF names only A and remediations happened. Always a **new**
entry — never edit a pre-remediation row; the same PDF path may be reused.

### QA checklist (audit-log PRs)

When reviewing a PR that mainly adds audit log/report entries, verify each point and **quote
evidence** (page/snippet/sha):

1. Report scope commit equals `auditCommitHash` (or a documented `n/a` reason).
2. If remediations exist, the report/addendum/`Fixed in #` supports `finalCommitHash` = D.
3. If the report only has A and findings were fixed in B/C/D, `finalCommitHash` is the tree that
   contains all fixes (not "latest by clock" unless that is also the signed-off tree).
4. Fail closed if remediations happened and `finalCommitHash` is missing.

## Steps

1. Extract all fields above. Rate each: **High** (unambiguous, cross-validated) → show for
   confirmation; **Medium** (needs interpretation) → flag and ask the user to verify;
   **Low/Missing** → ask the user to supply it.
2. **Audit ID**: `auditYYYYMMDD`, or `auditYYYYMMDD_N` if that date already exists.
3. **Filename** (`.agents/rules/501-audits.md`):
   - Single contract with version: `YYYY.MM.DD_ContractName(v1.0.0).pdf` (e.g.
     `2025.01.06_AcrossFacetV3(v1.1.0).pdf`) — always the `v` prefix.
   - Single contract without version: `YYYY.MM.DD_ContractName.pdf` (e.g.
     `2024.08.14_StargateFacetV2_ReAudit.pdf`).
   - Multiple contracts: `YYYY.MM.DD_CustomFileName.pdf` (e.g. `2025.01.10_Cantina_PreComp.pdf`).
   - Add `_ReAudit` for re-audits; `_1`, `_2`, … for same-day duplicates.
4. **Save the PDF** — find the pasted file:
   `find ~/Downloads ~/Desktop . -maxdepth 3 -name "*.pdf" -type f 2>/dev/null | grep -i "audit\|report\|repot"`
   - If the target name already exists in `audit/reports/`, never overwrite it and never treat it
     as proof the audit was logged (a run that died before the log write leaves exactly this
     state). `cmp -s "<source-path>" "audit/reports/<generated-filename>.pdf"`:
     identical → an earlier run was interrupted; keep it and continue. Different → a distinct
     same-day audit; use the next `_1` / `_2` suffix.
   - Otherwise `cp "<source-path>" "audit/reports/<generated-filename>.pdf"`, then
     `ls -lh` it (must exist, size > 0).
   - PDF not found or copy unverifiable → stop and ask for the file; write no log entry.
5. **Write the log entry** — `audit/auditLog.json` is the only proof an audit was logged:
   - First check `audits` for an entry with the same date, auditor, contracts, and
     `auditCommitHash`; if present, stop and say it's already logged. Don't test with the
     step-2 ID — it is unique by construction, so it never matches.
   - Add the entry to `audits` and update `auditedContracts` for each contract/version. Follow
     the existing structure; invent no fields.
6. **Summary** — list the extracted fields concisely, with the commit as a clickable markdown
   link, and ask the user to verify the hash:

   ```text
   Extracted Information:
   - Contract: AllBridgeFacet
   - Version: v2.1.2
   - Auditor: Sujith Somraaj (individual security researcher)
   - Date: 19.12.2025
   - Commit Hash: 8bbf470b470523eb582843deca6dbba755497e84
   - Commit URL: [https://github.com/lifinance/contracts/commit/8bbf470b…](https://github.com/lifinance/contracts/commit/8bbf470b470523eb582843deca6dbba755497e84)

   Please verify the commit hash is correct by clicking the link above.
   ```
