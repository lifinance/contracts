---
name: Agents authoring constraints
description: Auto-enforced constraints when editing any .agents/ rule or command — no-dup, size, naming, validation
globs:
  - '.agents/rules/*.md'
  - '.agents/commands/*.md'
paths:
  - '.agents/rules/*.md'
  - '.agents/commands/*.md'
---

## Edit target

Always edit in `.agents/rules/` or `.agents/commands/` — never the symlinks in `.cursor/` or `.claude/`.

## No-Duplication

Before adding any guideline, search existing rules/commands for the same concept (keywords and anchors). Decide the single owning file by scope:
- Universal → `000-*` always-apply rule.
- Language-specific → the language rule (`100-*`, `200-*`, `300-*`).
- Directory-specific → the narrowest directory rule.
- Workflow/runbook → a command (only if explicitly invoked, not tied to file editing).

Remove duplicates rather than keeping both in sync.

## Uniqueness

- No duplicate numeric prefixes (e.g., two `105-*` files).
- `name:` fields unique within `.agents/rules/` and within `.agents/commands/`.
- Globs don't unintentionally overlap.

## Size & focus

- One concern per rule/command.
- Target ≤ 500 lines. If a command grew past this, split before adding more.
- No "Quality Checklist" that restates rules already given in the steps above it.
- No standalone callouts that duplicate inline guidance — keep the rule where it is applied.
- No historical / "do-not-apply" notes — delete legacy references entirely.

## Skill authoring (commands)

- Every line costs tokens. Challenge each one: "Does Claude need this explanation?"
- Bullet lists beat prose preambles.
- Consistent terminology — pick one term per concept.
- Don't offer multiple options without a clear default.
- `name`: lowercase, hyphenated, gerund form preferred (`requesting-audit`). Max 64 chars.
- `description`: third person, present tense; include *what* and *when* to use it.

## Scoping (rules only)

- Use **specific globs** — target file types precisely to avoid unnecessary activation.
- Use `alwaysApply: true` (+ omit `paths:`) only for truly universal rules (generally `000-099`).

## Cross-references

- Avoid "see also" pointers and "Related Files" sections.
- Prefer "this rule is always active" or "this activates via globs" over linking another file.

## Validation (run before finalizing)

- `ls -l .cursor/rules/*.mdc` and `ls -l .claude/rules/*.md` — all should be symlinks into `.agents/rules/`.
- `ls -l .claude/skills/*/SKILL.md` — all should point into `.agents/commands/`.
- `.agents/README.md` table reflects all files in `.agents/rules/` and all commands in `.agents/commands/`.

## README update triggers

Update `.agents/README.md`:
- Rule changes: if `name`, `description`, or `globs` changed.
- Command changes: always update the Custom Commands table.

For step-by-step symlink creation and hybrid frontmatter examples, use `/add-new-rule`.
