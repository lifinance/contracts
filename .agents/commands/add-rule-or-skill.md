---
name: add-rule-or-skill
description: Standardize adding/updating rules & commands/skills in this repo (scoping, dedupe, naming, DRY symlink structure); use when authoring or revising an agent rule or command.
usage: /add-rule-or-skill
---

# Rule & Command Authoring (LI.FI Contracts)

> **Usage**: `/add-rule-or-skill`

This command is the single workflow for adding/updating **rules** and **commands/skills** in this repo.

## Repo Structure (DRY Symlink Setup)

Rules and commands have a single source of truth. Never edit the symlink targets directly.

```
.agents/rules/*.md           ← SOURCE OF TRUTH for rules (edit here)
  ↑ symlinked from:
  .cursor/rules/*.mdc        ← Cursor reads these (link name keeps .mdc; target is .md)
  .claude/rules/*.md         ← Claude Code reads these

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

## No-Duplication, Naming, Size, Cross-References

These constraints are enforced automatically via `010-agents-authoring` (auto-loaded when editing `.agents/rules/*.md` or `.agents/commands/*.md`). See that rule for the full list. Key reminders:

- Search before adding — pick a single owning file, remove duplicates.
- Rules define "what/why", not "how"; report CI/tooling suggestions separately.
- Follow `.agents/README.md` for numbering ranges.

## Adding a New Rule (step by step)

1. Determine scope → pick numbering range from `.agents/README.md`.
2. Create `.agents/rules/<NNN>-<name>.md` with hybrid frontmatter.
3. Create the Cursor and Claude Code symlinks:

   ```bash
   ln -sf "../../.agents/rules/<NNN>-<name>.md" ".cursor/rules/<NNN>-<name>.mdc"
   ln -sf "../../.agents/rules/<NNN>-<name>.md" ".claude/rules/<NNN>-<name>.md"
   ```

4. Update `.agents/README.md` table (name, range, description).
5. Run validation steps below.

## Adding a New Command/Skill (step by step)

1. Run `/skill-creator` (Anthropic built-in) to draft the skill content — it enforces ≤500 lines, progressive disclosure, and other best practices automatically.
2. Save the output to `.agents/commands/<name>.md`.
3. Create the Cursor and Claude Code symlinks:

   ```bash
   ln -sf "../../.agents/commands/<name>.md" ".cursor/commands/<name>.md"
   mkdir -p ".claude/skills/<name>"
   ln -sf "../../../.agents/commands/<name>.md" ".claude/skills/<name>/SKILL.md"
   ```

4. Verify: `ls -l .cursor/commands/<name>.md` and `ls -l .claude/skills/<name>/SKILL.md` should both show symlink arrows into `.agents/commands/`.

## Modifying an Existing Rule or Command

All constraints (no-duplication, size, naming, validation) apply equally on edits. `010-agents-authoring` enforces them automatically — no need to repeat them here. No symlink work is needed unless you renamed the file.

## Helper script exit codes

When a skill shells out to a project script (e.g. via `bunx tsx script/utils/foo.ts`), use this exit-code convention so the orchestrating skill can branch independently per target:

- **`0`** — success.
- **`1`** — real error (network, API, malformed input). Report stderr to the user and stop. Do **not** retry. Do **not** write a fallback artifact.
- **`2`** — recoverable misconfig (env var missing, optional credential absent). Fall through to an alternative path (manual fallback file, degraded mode) and tell the user which env var to set.

This split lets the skill process N targets independently — if one channel/network/recipient succeeds and another exits `2`, the skill continues for the survivors and only writes a fallback for the failed one.

## Validation Steps (PR-ready)

- **Symlink integrity**: `ls -l .cursor/rules/*.mdc` and `ls -l .claude/rules/*.md` — all entries should be symlinks (`->`) pointing into `.agents/rules/`.
- **Skill symlinks**: `ls -l .claude/skills/*/SKILL.md` — all should point into `.agents/commands/`.
- **README accuracy**: `.agents/README.md` table reflects all files in `.agents/rules/` and all commands in `.agents/commands/`.
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
