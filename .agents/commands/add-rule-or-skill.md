---
name: add-rule-or-skill
description: Standardize adding/updating rules & commands/skills in this repo (scoping, dedupe, naming, DRY symlink structure); use when authoring or revising an agent rule or command.
usage: /add-rule-or-skill
---

# Rule & Command Authoring (LI.FI Contracts)

Constraints on duplication, naming, size and cross-references live in `010-agents-authoring`, which auto-loads when you edit `.agents/rules/*.md` or `.agents/commands/*.md`. Numbering ranges are in `.agents/README.md`.

## Symlink layout

```text
.agents/rules/*.md           ← source of truth for rules
  .cursor/rules/*.mdc        ← Cursor (link name keeps .mdc; target is .md)
  .claude/rules/*.md         ← Claude Code

.agents/commands/*.md        ← source of truth for commands
  .cursor/commands/*.md      ← Cursor
  .claude/skills/<name>/SKILL.md  ← Claude Code skill bridge
```

## Hybrid frontmatter (rules)

Scoped rule:

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

Global rule:

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

Cursor ignores `paths:`; Claude Code ignores `alwaysApply:` and `globs:`; both ignore unknown keys.

Typical scopes by concern:

- Solidity: `**/*.sol`, narrower `src/**`, `src/Facets/**`, `src/Interfaces/**`, `src/Periphery/Receiver*.sol`, `script/**/*.s.sol`, `test/**/*.t.sol`
- TypeScript: `script/**/*.ts`, `tasks/**/*.ts`
- Bash: `**/*.sh`
- GitHub Actions: `.github/workflows/**/*.yml` / `**/*.yaml`
- Audits: `audit/**/*.json`, `audit/**/*.pdf`

## Adding a rule

1. Pick the numbering range from `.agents/README.md`.
2. Create `.agents/rules/<NNN>-<name>.md` with hybrid frontmatter.
3. Symlink:

   ```bash
   ln -sf "../../.agents/rules/<NNN>-<name>.md" ".cursor/rules/<NNN>-<name>.mdc"
   ln -sf "../../.agents/rules/<NNN>-<name>.md" ".claude/rules/<NNN>-<name>.md"
   ```

4. Update the `.agents/README.md` table (name, range, description).

## Adding a command/skill

1. Draft with `/skill-creator`, save to `.agents/commands/<name>.md`.
2. Symlink:

   ```bash
   ln -sf "../../.agents/commands/<name>.md" ".cursor/commands/<name>.md"
   mkdir -p ".claude/skills/<name>"
   ln -sf "../../../.agents/commands/<name>.md" ".claude/skills/<name>/SKILL.md"
   ```

3. Confirm `ls -l .cursor/commands/<name>.md .claude/skills/<name>/SKILL.md` both point into `.agents/commands/`.

Edits to an existing rule or command need no symlink work unless the file is renamed.

## Helper script exit codes

When a skill shells out to a project script (e.g. `bunx tsx script/utils/foo.ts`), use this convention so the skill can branch per target:

- **`0`** — success.
- **`1`** — real error (network, API, malformed input). Report stderr and stop. No retry, no fallback artifact.
- **`2`** — recoverable misconfig (env var missing, optional credential absent). Fall through to the alternative path (manual fallback file, degraded mode) and tell the user which env var to set.

This lets a skill process N targets independently: survivors continue, and only the target that exited `2` gets a fallback.

## Validation

Besides the symlink and README checks in `010-agents-authoring`:

- **Stale references**: grep `.agents/rules/` and `.agents/commands/` for references to removed files.
- **Activation sanity**: editing a facet (`src/Facets/*.sol`) pulls facet + Solidity baseline + architecture/security; a TS script pulls the TS rule (+ security if applicable); audit files pull audit rules.
- **Rule interaction**: identify which rules apply via `globs` to the files involved, and ensure the new rule doesn't conflict with or override higher-priority/global rules.

A rule change must not weaken the smart-contract baseline: single diamond entrypoint with thin facets and selector/storage invariants; Safe + timelock never bypassed, no admin shortcuts; reserved event emission locations and non-EVM receiver rules; input/config validation, no new external-call patterns without prior art, reentrancy and approval hygiene, no new privileged paths; deployment scripts in `script/` and tests mirroring `src/` under `test/solidity/`; audit log schema, report naming and CI expectations.
