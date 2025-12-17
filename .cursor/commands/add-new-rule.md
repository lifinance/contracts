---
name: add-new-rule
description: Standardize adding/updating Cursor rules & commands in this repo (scoping, dedupe, naming)
usage: /add-new-rule
---

# Rule Authoring (LI.FI Contracts)

> **Usage**: `/add-new-rule`

This command is the single workflow for adding/updating Cursor **rules** (`.cursor/rules/*.mdc`) and **commands** (`.cursor/commands/*.md`) in this repo.
This repo’s project commands should be stored as `.md` files in `.cursor/commands/` so Cursor can discover them for `/...` suggestions.

## Scoping & Activation (globs-first)

- Prefer **precise `globs`** over cross-references.
- Use `alwaysApply: true` only for rules that are truly universal (role/guardrails, architecture, project structure, context monitoring, final checks).
- Avoid `globs: ['**/*']` unless the rule is an explicit **activation gate** (like tx analysis) or truly universal.
- Prefer directory scoping by concern:
  - Solidity: `**/*.sol`, and narrower `src/**`, `src/Facets/**`, `src/Interfaces/**`, `src/Periphery/Receiver*.sol`, `script/**/*.s.sol`, `test/**/*.t.sol`
  - TypeScript: `script/**/*.ts`, `tasks/**/*.ts`
  - Bash: `**/*.sh`
  - GitHub Actions: `.github/workflows/**/*.yml` / `**/*.yaml`
  - Audits: `audit/**/*.json`, `audit/**/*.pdf`

## No-Duplication (single source of truth)

Before adding a new guideline:

- Search existing rules/commands for the same concept (keywords and anchors):
  - Examples: “NatSpec”, “LiFiTransferStarted”, “timelock”, “viem”, “expectRevert”, “auditReportPath”.
- Decide the **single owning file** by scope:
  - Universal → a `000-*` always-apply rule.
  - Language-specific → the language rule (`100-*`, `200-*`, `300-*`).
  - Directory-specific → the narrowest directory rule (facets/receivers/interfaces/tests).
  - Workflow/runbook → a **command** (only if it’s invoked explicitly and not tied to file editing).
- Remove duplicates rather than “keep both in sync”.

## Cross-Reference Minimization

- Avoid “see also” pointers.
- Prefer: “this rule is always active” or “this activates via globs” over linking another file.
- If a workflow truly must live in a command (explicitly invoked), keep rules minimal and avoid circular references.

## Naming Conventions + Uniqueness Check (repo source of truth)

- Follow `.cursor/rules/README.md` as the **single source of truth** for numbering ranges and naming.
- Uniqueness checks before committing:
  - No duplicate numeric prefixes (e.g., no two `105-*` files).
  - `name:` fields are unique within `.cursor/rules/` and within `.cursor/commands/`.
  - Globs don’t unintentionally overlap (e.g., a narrow rule shouldn’t be fully shadowed by a broader, conflicting one).

## Rule Size Limits & Split/Merge Guidance

- Keep each rule focused on **one concern**.
- Split when:
  - You’re mixing unrelated scopes (e.g., Solidity + TS in one rule).
  - The rule becomes a multi-topic checklist that’s hard to apply.
- Merge when:
  - Two rules always apply together and one is just a pointer.
  - A rule only repeats a requirement already covered by a broader rule that is always active in the same contexts.

## Validation Steps (PR-ready)

- Update `.cursor/rules/README.md` if you add/rename rules so the table stays accurate.
- Grep for stale references:
  - `.cursor/rules/` mentions of removed files
  - `.cursor/commands/` mentions of removed files
- Sanity-check activation:
  - Editing a facet (`src/Facets/*.sol`) pulls facet + Solidity baseline + architecture/security.
  - Editing a TS script pulls TS rule (+ security if applicable).
  - Editing audit files pulls audit rules.

## Smart-Contract Department Checklist (must not weaken)

- **Rule interaction (required)**:
  - Identify which rules will apply via `globs` for the files you’re about to touch.
  - Ensure the new rule does **not** conflict with or overwrite higher-priority/global rules.
  - Ensure there is **no duplicate guidance**: pick a single owning rule/command and delete/trim duplicates elsewhere.
  - Ensure numeric prefixes and `name:` fields stay **unique**.
- **Diamond architecture**: single diamond entrypoint; keep facets thin; selector/storage invariants respected.
- **Governance**: Safe + timelock flows never bypassed; no admin shortcuts.
- **Events**: respect reserved event emission locations; non-EVM receiver rules respected.
- **Security**: validate inputs/config; avoid new external-call patterns without prior art; reentrancy and approval hygiene; no new privileged paths.
- **Scripts/tests separation**: deployment/update scripts remain in `script/`; tests mirror `src/` under `test/solidity/`.
- **Audits**: audit log schema + report naming preserved; CI expectations respected.
