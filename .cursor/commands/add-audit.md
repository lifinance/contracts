---
name: add-audit
description: Add an audit report to the audit log by parsing a pasted PDF file
usage: /add-audit
---

# Add Audit Report Command

> **Usage**: `/add-audit` (then paste the PDF file into the chat)
>
> Example: Type `/add-audit` and then paste or attach the PDF audit report file

## Overview

This command processes a PDF audit report that you paste directly into the Cursor window and automatically:

1. Extracts audit metadata (contracts, versions, auditor, date, commit hash)
2. Generates the correct filename according to naming conventions
3. Updates `audit/auditLog.json` with the new audit entry
4. Saves the PDF file to `audit/reports/` with the correct filename

## Activation

When invoked, the command:

- Reads the PDF file from the pasted/attached content in the chat
- Extracts text content from the PDF
- Analyzes the text to identify:
  - **Contracts audited**: Contract names and their versions
  - **Auditor**: Name and GitHub handle (if available)
  - **Date**: Audit completion date
  - **Commit hash**: The commit hash that was audited (or "n/a" with explanation)
- Displays extracted information for confirmation
- Updates the audit log and saves the PDF file with the correct name

## Extraction Strategy

When a PDF is pasted, extract text content and use these strategies:

1. **Contract names and versions**:

   - **Primary search**: Look in title, header, "Scope", "Contracts Audited", or "Subject" sections
   - **Patterns to find**:
     - `ContractName(v1.0.0)` or `ContractName (v1.0.0)`
     - `Contract Name v1.0.0` or `Contract Name version 1.0.0`
     - `Contract: Name v1.0.0`
     - Version may be in parentheses: `(v1.0.0)`, `(1.0.0)`, or without: `v1.0.0`, `1.0.0`
   - **Important**: Many reports don't include version in the title - check the PDF content thoroughly
   - **If version not found in PDF**:
     - Check `@custom:version` tag in the actual contract file in `src/`
     - If still not found, ask user for version
   - **Multiple contracts**: Extract all contract names and versions if audit covers multiple contracts
   - **Cross-validation**: Verify contract names exist in `src/` directories (Facets, Periphery, Helpers, Libraries, Security)
   - **Special cases**:
     - "ReAudit" or "Re-Audit" in title indicates a re-audit (version may be same or updated)
     - Custom names like "PreComp", "Comp" for comprehensive audits covering multiple contracts

2. **Auditor information**:

   - **Search locations**: Footer, header, "Prepared by", "Audited by", "Security researcher", "About", cover page
   - **Name patterns**:
     - "Audited by: [Name]"
     - "Prepared by: [Name]"
     - "Security researcher: [Name]"
     - Firm names: "Cantina", "Burra Security", etc.
   - **GitHub handle patterns**:
     - `@username` or `github.com/username`
     - "GitHub: username" or "GitHub handle: username"
     - May be in footer, signature, or contact section
   - **Known auditor mappings** (check existing `audit/auditLog.json`):
     - "Sujith Somraaj" → "Sujith Somraaj (individual security researcher)" → "sujithsomraaj"
     - "Cantina" → "Cantina" or "Cantina (security firm)" → "cantinaxyz"
     - "Burra Security" → "Burra Security" → "burrasec"
   - **Format requirements**:
     - Individual: "Name (individual security researcher)"
     - Firm: "Firm Name" or "Firm Name (security firm)"
   - **If GitHub handle not found**: Use "n/a" (some older audits don't have it)

3. **Date extraction**:

   - **Search locations**: Header, footer, "Date:", "Completed on:", "Audit date:", cover page
   - **Date patterns**:
     - `DD.MM.YYYY` (e.g., "06.01.2025")
     - `YYYY-MM-DD` (e.g., "2025-01-06")
     - `MM/DD/YYYY` (e.g., "01/06/2025")
     - `DD-MM-YYYY` (e.g., "06-01-2025")
   - **Context clues**: Look near "completed", "audit", "date", "on", "dated", "issued"
   - **Conversion**: Convert to audit log format: `DD.MM.YYYY` or `YYYY-MM-DD` (be consistent with existing entries)
   - **Validation**:
     - Date should be reasonable (not in future, not too old - typically within last 2 years)
     - If multiple dates found, prefer the one near "completed" or "audit date"

4. **Commit hash**:
   - **Pattern**: 40-character hexadecimal string: `[0-9a-f]{40}`
   - **Search locations**:
     - "Commit:", "Commit hash:", "Git commit:", "SHA:", "Hash:"
     - May be in a "Version Information" or "Code Version" section
     - Footer or appendix
   - **If not found**:
     - Search for "n/a" with nearby explanation
     - Common explanations:
       - "n/a (This is a forked contract that was audited for [project])"
       - "n/a (one deployed contract instance was audited)"
       - "n/a (audited deployed version)"
   - **Validation**: Commit hash must be exactly 40 hex characters, or "n/a" with explanation

## File Naming

The script generates filenames according to `.cursor/rules/501-audits.mdc`:

- **Single contract**: `YYYY.MM.DD_ContractName(version).pdf`
- **Multiple contracts**: `YYYY.MM.DD_CustomFileName.pdf`
- Date format must match `auditCompletedOn` date

## Audit Log Updates

Update `audit/auditLog.json` following its existing structure (do not invent new fields). Use existing entries as the template for required keys and formatting.

## Validation

Before finalizing, validate:

- [ ] **All required fields present**: date, auditor, contracts, commit hash
- [ ] **Date format**: Valid `DD.MM.YYYY` or `YYYY-MM-DD` format, reasonable date
- [ ] **Contract names**: Match actual contract files in `src/` (check Facets, Periphery, Helpers, Libraries, Security)
- [ ] **Versions**:
  - If version found in PDF, verify it matches `@custom:version` tag in contract file
  - If version not in PDF, use version from `@custom:version` tag
  - If no version tag exists, ask user
- [ ] **Commit hash**:
  - Either 40-character hex string OR
  - "n/a" with explanation (must include explanation, not just "n/a")
- [ ] **Auditor format**:
  - Individual: "Name (individual security researcher)"
  - Firm: "Firm Name" or "Firm Name (security firm)"
- [ ] **GitHub handle**: Valid username or "n/a" (check against known auditors in existing log)
- [ ] **Audit ID**: Unique, no duplicates (check existing `audits` section)
- [ ] **Filename**: Follows naming convention, doesn't already exist in `audit/reports/`

## Execution Steps

When `/add-audit` is invoked with a pasted PDF:

1. **Read the PDF**: Extract all text content from the pasted PDF file
2. **Extract metadata**: Use the extraction strategies above to identify:
   - Contracts and versions (list all if multiple)
   - Auditor name and GitHub handle
   - Audit completion date
   - Commit hash (or "n/a" with explanation)
3. **Validate**: Cross-check contract names exist in `src/`, versions match `@custom:version` tags
4. **Generate audit ID**: Create unique ID (`auditYYYYMMDD` or `auditYYYYMMDD_N` if same-day audit exists)
5. **Generate filename**:
   - **Single contract with version**: `YYYY.MM.DD_ContractName(version).pdf` (e.g., `2025.01.06_AcrossFacetV3(v1.1.0).pdf`)
   - **Single contract without version in PDF**: `YYYY.MM.DD_ContractName.pdf` (e.g., `2024.08.14_StargateFacetV2_ReAudit.pdf`)
   - **Multiple contracts**: `YYYY.MM.DD_CustomFileName.pdf` (e.g., `2025.01.10_Cantina_PreComp.pdf`)
   - **Version format**: Use `v1.0.0` format (with "v" prefix) in parentheses
   - **Special suffixes**:
     - Add `_ReAudit` if it's a re-audit (check PDF title/content)
     - For same-day duplicates, add `_1`, `_2`, etc. to filename if needed
6. **Assess extraction confidence**: Evaluate how confident you are in each extracted field:
   - **High confidence**: Clear, unambiguous match in PDF
   - **Medium confidence**: Found but requires interpretation or cross-validation
   - **Low confidence**: Uncertain, ambiguous, or missing
7. **Display summary with confidence indicators**:
   - Show extracted information clearly
   - **CRITICAL**: Flag any fields with low/medium confidence or missing data
   - Use clear warnings: "⚠️ WARNING: [field] extraction is uncertain - please verify"
   - Ask user to verify or supply missing information before proceeding
8. **User verification**:
   - **DO NOT proceed** if any required field is missing or uncertain without user confirmation
   - Ask user to confirm or correct each uncertain field
   - Only proceed after user explicitly confirms all extracted data
9. **Update audit log** (only after user confirmation):
   - Add entry to `audits` section
   - Update `auditedContracts` mapping for each contract/version
10. **Save PDF**: Write the PDF file to `audit/reports/` with correct filename
11. **Confirm**: Show success message with audit ID and filename

## Data Extraction Confidence and User Verification

**CRITICAL**: Always assess extraction confidence and require user verification for uncertain data.

### Confidence Levels

- **High Confidence**:

  - Clear, unambiguous text match in PDF
  - Matches known patterns exactly
  - Cross-validated against contract files
  - **Action**: Can proceed, but still show for confirmation

- **Medium Confidence**:

  - Found but requires interpretation
  - Multiple possible matches
  - Format doesn't match expected pattern exactly
  - **Action**: ⚠️ **MUST flag and ask user to verify**

- **Low Confidence / Missing**:
  - Not found in PDF
  - Ambiguous or unclear
  - Contradicts expected patterns
  - **Action**: ⚠️ **MUST ask user to supply information manually**

### Required Warnings

When displaying extracted information, **ALWAYS** include confidence indicators:

```
Extracted Information:
- Contract: AcrossFacetV3 ⚠️ (version not found in PDF, using @custom:version tag)
- Version: v1.1.0 ⚠️ (inferred from contract file, please verify)
- Auditor: Sujith Somraaj ✅ (high confidence)
- Date: 06.01.2025 ⚠️ (found multiple dates, using most likely - please verify)
- Commit Hash: ⚠️ NOT FOUND - please provide
```

### User Verification Required

**DO NOT proceed with audit log update if:**

- Any required field is missing
- Any field has low/medium confidence without user confirmation
- Contract name doesn't match files in `src/`
- Version doesn't match `@custom:version` tag
- Date seems incorrect (future date, too old, etc.)
- Commit hash format is invalid

**Always ask**: "Please verify the extracted information above. Are all fields correct? Please provide any missing or incorrect information."

## Error Handling

The command handles:

- Missing or unreadable PDF files (if PDF not pasted/attached)
- Invalid PDF format
- Missing required fields
- Duplicate audit entries
- Invalid JSON structure
- File system errors (when saving PDF or updating audit log)

## How to Use

1. Type `/add-audit` in the chat
2. Paste or attach the PDF audit report file directly into the chat window
3. The command will automatically:
   - Extract all metadata from the PDF
   - Display the extracted information
   - Ask for confirmation or corrections
   - Update the audit log
   - Save the PDF with the correct filename

## Output

On success, the command:

- Displays the generated audit entry
- Shows the new filename
- Confirms the PDF report is filed correctly in `audit/reports/` with the correct name
- Confirms audit log update
- Provides a summary of changes

## Key Files

- `audit/auditLog.json` - Audit log to update
- `audit/reports/` - Target directory for PDF files
- `src/**/*.sol` - Contract files for validation

## Implementation Notes

- The AI agent can directly read and analyze pasted PDF files
- Implement all logic directly using the patterns described above
- No helper scripts needed - extract, validate, and update the audit log directly
