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
4. **MANDATORY**: Locates and saves the PDF file to `audit/reports/` with the correct filename

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
- **CRITICAL - Commit hash verification**:
  - **ALWAYS** generate and display GitHub commit URL: `https://github.com/lifinance/contracts/commit/<full-40-char-hash>`
  - Extract repository name from PDF if different (default to "lifinance/contracts")
  - **ALWAYS** warn user to verify by clicking the URL
  - Display as clickable link in summary output
  - If commit hash is "n/a", skip URL generation

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

5. **Generate filename** (according to `.cursor/rules/501-audits.mdc`):

   - **Single contract with version**: `YYYY.MM.DD_ContractName(version).pdf` (e.g., `2025.01.06_AcrossFacetV3(v1.1.0).pdf`)
   - **Single contract without version**: `YYYY.MM.DD_ContractName.pdf` (e.g., `2024.08.14_StargateFacetV2_ReAudit.pdf`)
   - **Multiple contracts**: `YYYY.MM.DD_CustomFileName.pdf` (e.g., `2025.01.10_Cantina_PreComp.pdf`)
   - **Version format**: Use `v1.0.0` format (with "v" prefix) in parentheses
   - **Special suffixes**: Add `_ReAudit` if re-audit; add `_1`, `_2`, etc. for same-day duplicates

6. **Assess extraction confidence** for each field:

   - **High**: Clear, unambiguous match; cross-validated → Show for confirmation
   - **Medium**: Found but requires interpretation → ⚠️ **MUST flag and ask user to verify**
   - **Low/Missing**: Not found, ambiguous → ⚠️ **MUST ask user to supply manually**

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
   - **CRITICAL**: Both audit log update and PDF file saving must be completed

8. **Display concise summary for user verification**:

   - List all extracted information in a concise format
   - **CRITICAL - Commit hash verification**:
     - **ALWAYS** display GitHub commit URL as a clickable markdown link: `[Commit URL](https://github.com/lifinance/contracts/commit/<hash>)`
     - Ask user to verify the commit hash by clicking the link
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

## Validation Checklist

Before finalizing, validate all of the following:

- [ ] **All required fields present**: date, auditor, contracts, commit hash
- [ ] **Date format**: Valid `DD.MM.YYYY` or `YYYY-MM-DD` format, reasonable date
- [ ] **Contract names**: Match actual contract files in `src/` (check Facets, Periphery, Helpers, Libraries, Security)
- [ ] **Versions**: If found in PDF, verify matches `@custom:version` tag; if not in PDF, use version from tag; if no tag, ask user
- [ ] **Commit hash**: Either 40-character hex string OR "n/a" with explanation; if provided, GitHub commit URL generated and displayed
- [ ] **Auditor format**: Individual: "Name (individual security researcher)"; Firm: "Firm Name" or "Firm Name (security firm)"
- [ ] **GitHub handle**: Valid username or "n/a" (check against known auditors in existing log)
- [ ] **Audit ID**: Unique, no duplicates (check existing `audits` section)
- [ ] **Filename**: Follows naming convention, doesn't already exist in `audit/reports/`
- [ ] **PDF file saved**: File exists at `audit/reports/<generated-filename>.pdf` with size > 0 bytes

## Error Handling

The command handles:

- Missing or unreadable PDF files (if PDF not pasted/attached)
- Invalid PDF format
- Missing required fields
- Duplicate audit entries
- Invalid JSON structure
- File system errors (when saving PDF or updating audit log)
- **CRITICAL**: If PDF cannot be saved, do NOT complete the audit entry - ask user for help

## Key Files

- `audit/auditLog.json` - Audit log to update
- `audit/reports/` - Target directory for PDF files
- `src/**/*.sol` - Contract files for validation

## Implementation Notes

- The AI agent can directly read and analyze pasted PDF files
- Implement all logic directly using the patterns described above
- No helper scripts needed - extract, validate, and update the audit log directly
- **CRITICAL**: PDF file saving is MANDATORY - the audit entry is incomplete without the PDF file saved to `audit/reports/`
- Never mark an audit entry as complete without verifying the PDF file exists at the correct path
