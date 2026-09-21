---
name: add-audit
description: Add an audit report to the audit log by parsing a pasted PDF file
usage: /add-audit
---

# Add Audit Report Command

> **Usage**: `/add-audit` (then paste the PDF file into the chat)

## Overview

This command processes a PDF audit report and automatically:

1. Extracts audit metadata (contracts, versions, auditor, date, commit hash)
2. Generates the correct filename according to naming conventions
3. Updates `audit/auditLog.json` with the new audit entry
4. Saves the PDF to `audit/reports/` under the generated filename — the log entry is not complete without it

## How to Use

1. Type `/add-audit` in the chat
2. Paste or attach the PDF audit report file directly into the chat window
3. The command will automatically extract metadata, update the audit log, save the PDF file, and display results for verification

## Extraction Strategy

### 1. Contract Names and Versions

- **Search locations**: Title, header, "Scope", "Contracts Audited", "Subject" sections
- **Patterns**: `ContractName(v1.0.0)`, `Contract Name v1.0.0`, `Contract: Name version 1.0.0`
- **Version formats**: `(v1.0.0)`, `(1.0.0)`, `v1.0.0`, `1.0.0`
- **If version not found**: Check `@custom:version` tag in contract file (`src/`), or ask user
- **Cross-validation**: Verify contract exists in `src/` (Facets, Periphery, Helpers, Libraries, Security)
- **Special cases**:
  - "ReAudit" or "Re-Audit" in title → re-audit (version may be same or updated)
  - "PreComp", "Comp" → comprehensive audits covering multiple contracts

### 2. Auditor Information

- **Search locations**: Footer, header, "Prepared by", "Audited by", "Security researcher", "About", cover page
- **Name patterns**: "Audited by: [Name]", "Prepared by: [Name]", "Security researcher: [Name]"
- **GitHub handle patterns**: `@username`, `github.com/username`, "GitHub: username"
- **Known auditor mappings** (check `audit/auditLog.json`):
  - "Sujith Somraaj" → "Sujith Somraaj (individual security researcher)" → "sujithsomraaj"
  - "Cantina" → "Cantina" or "Cantina (security firm)" → "cantinaxyz"
  - "Burra Security" → "Burra Security" → "burrasec"
- **Format requirements**:
  - Individual: "Name (individual security researcher)"
  - Firm: "Firm Name" or "Firm Name (security firm)"
- **If GitHub handle not found**: Use "n/a"

### 3. Date Extraction

- **Search locations**: Header, footer, "Date:", "Completed on:", "Audit date:", cover page
- **Date patterns**: `DD.MM.YYYY`, `YYYY-MM-DD`, `MM/DD/YYYY`, `DD-MM-YYYY`
- **Context clues**: Look near "completed", "audit", "date", "on", "dated", "issued"
- **Conversion**: Convert to audit log format: `DD.MM.YYYY` or `YYYY-MM-DD` (be consistent with existing entries)
- **Validation**: Date should be reasonable (not in future, not too old - typically within last 2 years)
- **If multiple dates found**: Prefer the one near "completed" or "audit date"

### 4. Commit Hash

- **Pattern**: 40-character hexadecimal string: `[0-9a-f]{40}`
- **Search locations**: "Commit:", "Commit hash:", "Git commit:", "SHA:", "Hash:", footer, appendix
- **Note**: Commit hash may be a clickable link in the PDF (especially if short hash)
- **Short hash resolution** (if < 40 characters):
  1. **Try local git**: `git rev-parse <short-hash>` in contracts repository
  2. **Try GitHub API**: `curl -s "https://api.github.com/repos/<repo>/commits/<short-hash>" | python3 -c "import sys, json; data = json.load(sys.stdin); print(data.get('sha', ''))"`
     - Extract repository name from PDF (default: "lifinance/contracts")
  3. **If both fail**: Ask user for full hash or GitHub commit URL
- **If not found**: Search for "n/a" with explanation:
  - "n/a (This is a forked contract that was audited for [project])"
  - "n/a (one deployed contract instance was audited)"
  - "n/a (audited deployed version)"
- **Commit hash verification**: display the hash as a clickable GitHub URL
  (`https://github.com/lifinance/contracts/commit/<full-40-char-hash>`; repo name from
  the PDF, default `lifinance/contracts`) and ask the user to click through and confirm
  it — a wrong hash pins the audit to a tree that was never audited. Skip when "n/a".
- **Post-remediation ([CONV:AUDIT-PIN])**:
  - `auditCommitHash` = scope commit **A** from the report (what was sent).
  - If findings were fixed afterwards, also set `finalCommitHash` = post-remediation
    commit **D** the auditor signed off on (same report, addendum, or confirmation).
  - The content gate pins to `finalCommitHash` when present, else `auditCommitHash`.
  - Ask the user for D when the PDF only names A and remediations happened.
  - Always a **new** log entry — never edit a pre-remediation row. Same PDF path may be reused.

### QA checklist (audit-log PRs)

When reviewing a PR that only (or mainly) adds audit log/report entries, verify and
**quote evidence** (page/snippet/sha) — do not rubber-stamp:

1. Report scope commit equals `auditCommitHash` (or documented `n/a` reason).
2. If remediations exist: report/addendum/`Fixed in #` support `finalCommitHash` = D.
3. If the report only has A and finding fixes B/C/D: `finalCommitHash` is the tree that
   contains all fixes (not “latest by clock” unless that is also the signed-off tree).
4. Fail closed if remediations happened and `finalCommitHash` is missing from the log.

## Execution Steps

When `/add-audit` is invoked with a pasted PDF:

1. **Extract PDF content**: Read all text content from the pasted PDF file

2. **Extract metadata** using extraction strategies above:

   - Contracts and versions (list all if multiple)
   - Auditor name and GitHub handle
   - Audit completion date
   - Commit hash (or "n/a" with explanation)
   - If commit hash is short (< 40 chars): Resolve to full hash (see section 4 above)

3. **Validate extracted data**:

   - Cross-check contract names exist in `src/` directories
   - Verify versions match `@custom:version` tags in contract files
   - Validate date format and reasonableness
   - Validate commit hash format (40 hex chars or "n/a" with explanation)

4. **Generate audit ID**: Create unique ID (`auditYYYYMMDD` or `auditYYYYMMDD_N` if same-day audit exists)

5. **Generate filename** (according to `.agents/rules/501-audits.md`):

   - **Single contract with version**: `YYYY.MM.DD_ContractName(version).pdf` (e.g., `2025.01.06_AcrossFacetV3(v1.1.0).pdf`)
   - **Single contract without version**: `YYYY.MM.DD_ContractName.pdf` (e.g., `2024.08.14_StargateFacetV2_ReAudit.pdf`)
   - **Multiple contracts**: `YYYY.MM.DD_CustomFileName.pdf` (e.g., `2025.01.10_Cantina_PreComp.pdf`)
   - **Version format**: Use `v1.0.0` format (with "v" prefix) in parentheses
   - **Special suffixes**: Add `_ReAudit` if re-audit; add `_1`, `_2`, etc. for same-day duplicates

6. **Assess extraction confidence** for each field:

   - **High**: Clear, unambiguous match; cross-validated → Show for confirmation
   - **Medium**: found but needs interpretation → flag it and ask the user to verify
   - **Low/Missing**: not found or ambiguous → ask the user to supply it

7. **Update audit log and save PDF file** (do the work automatically):

   - Add entry to `audits` section in `audit/auditLog.json`
   - Update `auditedContracts` mapping for each contract/version
   - Follow existing structure (do not invent new fields)
   - **Locate and save PDF file** (use the PDF file that was already pasted into the chat):
     - **Search for PDF file** in common locations (in order):
       1. User's Downloads: `~/Downloads/` or `/Users/<username>/Downloads/`
       2. User's Desktop: `~/Desktop/` or `/Users/<username>/Desktop/`
       3. Current workspace: `.` or workspace root
       4. Search command: `find ~/Downloads ~/Desktop . -maxdepth 3 -name "*.pdf" -type f 2>/dev/null | grep -i "audit\|report\|repot"`
     - **If PDF found**:
       - Copy: `cp "<source-path>" "audit/reports/<generated-filename>.pdf"`
       - Verify: `ls -lh "audit/reports/<generated-filename>.pdf"` (must show file exists, size > 0 bytes)
     - **If PDF not found**: Note in output that PDF file needs to be provided

8. **Display concise summary for user verification**:

   - List all extracted information in a concise format
   - Display the commit URL as a clickable markdown link — `[Commit URL](https://github.com/lifinance/contracts/commit/<hash>)` — and ask the user to verify it
   - Keep output concise - just list extracted info and ask to verify commit hash
   - Example output:

     ```
     Extracted Information:
     - Contract: AllBridgeFacet
     - Version: v2.1.2
     - Auditor: Sujith Somraaj (individual security researcher)
     - Date: 19.12.2025
     - Commit Hash: 8bbf470b470523eb582843deca6dbba755497e84
     - Commit URL: [https://github.com/lifinance/contracts/commit/8bbf470b470523eb582843deca6dbba755497e84](https://github.com/lifinance/contracts/commit/8bbf470b470523eb582843deca6dbba755497e84)

     Please verify the commit hash is correct by clicking the link above.
     ```

## Error Handling

The command handles:

- Missing or unreadable PDF files (if PDF not pasted/attached)
- Invalid PDF format
- Missing required fields
- Duplicate audit entries
- Invalid JSON structure
- File system errors (when saving PDF or updating audit log)
- If the PDF cannot be saved, stop before writing the log entry and ask the user for the file

## Key Files

- `audit/auditLog.json` - Audit log to update
- `audit/reports/` - Target directory for PDF files
- `src/**/*.sol` - Contract files for validation

## Implementation Notes

- No helper scripts — extract, validate, and update `audit/auditLog.json` directly.
- An entry is complete only once `audit/reports/<filename>.pdf` exists and is non-empty; verify with `ls -lh` before reporting success.
