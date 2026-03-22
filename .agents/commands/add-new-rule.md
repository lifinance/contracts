---
name: add-new-rule
description: Standardize adding/updating rules & commands/skills in this repo (scoping, dedupe, naming, DRY symlink structure)
usage: /add-new-rule
---

# Rule & Command Authoring (LI.FI Contracts)

> **Usage**: `/add-new-rule`

This command is the single workflow for adding/updating **rules** and **commands/skills** in this repo.

## Repo Structure (DRY Symlink Setup)

Rules and commands have a single source of truth. Never edit the symlink targets directly.

```
.agents/rules/*.mdc          ← SOURCE OF TRUTH for rules (edit here)
  ↑ symlinked from:
  .cursor/rules/*.mdc        ← Cursor reads these (same extension)
  .claude/rules/*.md         ← Claude Code reads these (extension mapped)

.agents/commands/*.md        ← SOURCE OF TRUTH for commands (edit here)
  ↑ symlinked from:
  .cursor/commands/*.md      ← Cursor reads these
  .claude/skills/<name>/SKILL.md  ← Claude Code skill bridge
```

When you add or edit a rule, **always work in `.agents/rules/`**.
When you add or edit a command, **always work in `.agents/commands/`**.

## Hybrid Frontmatter (both tools, one file)

Every rule must use the hybrid header so both Cursor and Claude Code activate it correctly.

**Scoped rule** (activates only for matching files):
```yaml
---
name: Rule name
description: One-sentence description
globs:           # Cursor: file matching
  - 'src/**/*.sol'
paths:           # Claude Code: file matching (no negation patterns)
  - 'src/**/*.sol'
---
```

**Global rule** (always active, no file scoping):
```yaml
---
name: Rule name
description: One-sentence description
globs:            # Cursor: match all files
  - '**/*'
alwaysApply: true # Cursor: force-load
                  # Claude Code: omit paths: entirely = always loaded
---
```

Rules: Cursor ignores `paths:`. Claude Code ignores `alwaysApply:` and `globs:`. Both ignore unknown keys.

Negation patterns (`!src/**/*.s.sol`) are supported in `globs:` (Cursor) but **not** in `paths:` (Claude Code) — omit them from `paths:`.

## Scoping & Activation (globs-first)

- Prefer **precise `globs`** over cross-references.
- Use `alwaysApply: true` (+ omit `paths:`) only for truly universal rules (role/guardrails, architecture, project structure, context monitoring, final checks).
- Avoid `globs: ['**/*']` unless the rule is an explicit **activation gate** (like tx analysis) or truly universal.
- Prefer directory scoping by concern:
  - Solidity: `**/*.sol`, narrower `src/**`, `src/Facets/**`, `src/Interfaces/**`, `src/Periphery/Receiver*.sol`, `script/**/*.s.sol`, `test/**/*.t.sol`
  - TypeScript: `script/**/*.ts`, `tasks/**/*.ts`
  - Bash: `**/*.sh`
  - GitHub Actions: `.github/workflows/**/*.yml` / `**/*.yaml`
  - Audits: `audit/**/*.json`, `audit/**/*.pdf`

## No-Duplication (single source of truth)

Before adding a new guideline:

- Search existing rules/commands for the same concept (keywords and anchors):
  - Examples: "NatSpec", "LiFiTransferStarted", "timelock", "viem", "expectRevert", "auditReportPath".
- Decide the **single owning file** by scope:
  - Universal → a `000-*` always-apply rule.
  - Language-specific → the language rule (`100-*`, `200-*`, `300-*`).
  - Directory-specific → the narrowest directory rule (facets/receivers/interfaces/tests).
  - Workflow/runbook → a **command** (only if it's invoked explicitly and not tied to file editing).
- Remove duplicates rather than "keep both in sync".

## Cross-Reference Minimization

- Avoid "see also" pointers.
- Prefer: "this rule is always active" or "this activates via globs" over linking another file.
- If a workflow truly must live in a command (explicitly invoked), keep rules minimal and avoid circular references.
- **Avoid "Related Files" sections**: Only include file references if the rule directly depends on specific file locations or the files are explicitly mentioned in the rule's requirements.

## Keep Implementation Details Separate

- **Rules define "what" and "why", not "how"**: Rules state requirements, constraints, and behaviors. Implementation details (CI workflows, tooling setup) do NOT belong in the rule.
- **Report implementation suggestions separately**: When creating a rule, if you identify helpful implementation approaches, report these back to the user as suggestions, but do NOT include them in the rule file.
- **What belongs in rules**: requirements/constraints, example code and anti-patterns, behavioral expectations, agent behavior instructions, rationale.
- **What to exclude**: CI workflow code, detailed tooling setup, optional enforcement mechanisms.

## Naming Conventions + Uniqueness Check

- Follow `.agents/rules/README.md` as the **single source of truth** for numbering ranges and naming.
- Uniqueness checks before committing:
  - No duplicate numeric prefixes (e.g., no two `105-*` files).
  - `name:` fields are unique within `.agents/rules/` and within `.agents/commands/`.
  - Globs don't unintentionally overlap.

## Rule Size Limits & Split/Merge Guidance

- Keep each rule focused on **one concern**.
- Split when:
  - You're mixing unrelated scopes (e.g., Solidity + TS in one rule).
  - The rule becomes a multi-topic checklist that's hard to apply.
- Merge when:
  - Two rules always apply together and one is just a pointer.
  - A rule only repeats a requirement already covered by a broader rule always active in the same contexts.

## Adding a New Rule (step by step)

1. Determine scope → pick numbering range from `.agents/rules/README.md`.
2. Create `.agents/rules/<NNN>-<name>.mdc` with hybrid frontmatter.
3. Symlinks are already in place — no action needed for `.cursor/rules/` or `.claude/rules/`.
4. Update `.agents/rules/README.md` table (name, range, description).
5. Run validation steps below.

## Adding a New Command/Skill (step by step)

1. Create `.agents/commands/<name>.md` with the command content.
2. Create the Cursor and Claude Code symlinks:
   ```bash
   ln -sf "../../.agents/commands/<name>.md" ".cursor/commands/<name>.md"
   mkdir -p ".claude/skills/<name>"
   ln -sf "../../../.agents/commands/<name>.md" ".claude/skills/<name>/SKILL.md"
   ```
3. Verify: `ls -l .cursor/commands/<name>.md` and `ls -l .claude/skills/<name>/SKILL.md` should both show symlink arrows into `.agents/commands/`.

## Validation Steps (PR-ready)

- **Symlink integrity**: `ls -l .cursor/rules/*.mdc` and `ls -l .claude/rules/*.md` — all entries should be symlinks (`->`) pointing into `.agents/rules/`.
- **Skill symlinks**: `ls -l .claude/skills/*/SKILL.md` — all should point into `.agents/commands/`.
- **README accuracy**: `.agents/rules/README.md` table reflects all files in `.agents/rules/`.
- **Stale references**: grep `.agents/rules/` and `.agents/commands/` for references to removed files.
- **Activation sanity check**:
  - Editing a facet (`src/Facets/*.sol`) → pulls facet + Solidity baseline + architecture/security.
  - Editing a TS script → pulls TS rule (+ security if applicable).
  - Editing audit files → pulls audit rules.

## Smart-Contract Department Checklist (must not weaken)

- **Rule interaction (required)**:
  - Identify which rules will apply via `globs` for the files you're about to touch.
  - Ensure the new rule does **not** conflict with or overwrite higher-priority/global rules.
  - Ensure there is **no duplicate guidance**: pick a single owning rule/command and delete/trim duplicates elsewhere.
  - Ensure numeric prefixes and `name:` fields stay **unique**.
- **Diamond architecture**: single diamond entrypoint; keep facets thin; selector/storage invariants respected.
- **Governance**: Safe + timelock flows never bypassed; no admin shortcuts.
- **Events**: respect reserved event emission locations; non-EVM receiver rules respected.
- **Security**: validate inputs/config; avoid new external-call patterns without prior art; reentrancy and approval hygiene; no new privileged paths.
- **Scripts/tests separation**: deployment/update scripts remain in `script/`; tests mirror `src/` under `test/solidity/`.
- **Audits**: audit log schema + report naming preserved; CI expectations respected.
