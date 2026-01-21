---
name: create-cursor-command
description: Create a concise, deterministic Cursor slash command for this repo (requirements-first, repo-patterns, token discipline)
usage: /create-cursor-command
---

# Create Cursor Command (LI.FI)

> **Usage**: `/create-cursor-command`

This meta-command guides the assistant to author a **concise, efficient, and effective** Cursor slash command for this repo, using the same conventions as existing commands (frontmatter, deterministic steps, explicit inputs/outputs, safety guardrails, token discipline).

## When to use this command

- Use when you want to add a new **explicit workflow** the team will run manually via `/...` (e.g., “simulate calldata”, “analyze tx”, “generate X artifact”).
- Use when you need the command to be **repeatable**: clear inputs, deterministic steps, and a fixed output format.

## When NOT to use this command

- Don’t use for **always-on editing guidance** tied to file patterns → create/update a **rule** instead (`.cursor/rules/*.mdc` with `globs` / `alwaysApply`).
- Don’t use for **project documentation** → update `docs/` instead.

## Inputs (what the user must provide)

The assistant must gather (and later encode) the following. Prefer asking via the question flow below (1–2 questions at a time).

| Input | Required | Notes / Constraints | Example |
|------|----------|---------------------|---------|
| **Command goal** | ✅ | One sentence describing the outcome | “Create calldata for a diamond cut” |
| **Scope** | ✅ | What’s in/out; which repo areas it touches | “Only uses `out/*/methodIdentifiers` + `diamond.json`” |
| **Audience** | ✅ | Who will run it; expected skill level | “Protocol engineers, comfortable with Foundry” |
| **Command name** | ✅ | `kebab-case`, **action verb**, unambiguous | `generate-diamond-cut` |
| **Usage string** | ✅ | Show required args + optional flags | `/generate-diamond-cut <network> <facet> [--dry-run]` |
| **Inputs schema** | ✅ | Args + flags with defaults and validation | `--network <key>` from `config/networks.json` |
| **Output expectations** | ✅ | Explicit output format + template | “Markdown report with sections X/Y/Z” |
| **Safety constraints** | ✅ | No destructive actions unless explicitly requested | “No broadcasts; read-only only” |
| **Dependencies / prereqs** | ✅ | Tooling + env vars; no hidden assumptions | “Requires premium RPC env var; no public fallback” |
| **Repo patterns to align with** | ✅ | Reference canonical files only when relevant | `config/networks.json`, `deployments/`, `config/whitelist.json`, `diamond.json`, `out/*/methodIdentifiers` |

## Command vs Rule decision (must do early)

The assistant must explicitly decide which artifact to create:

- **Create a command** (`.cursor/commands/*.md`) when:
  - It’s an explicit workflow invoked on demand via `/...`
  - It is not inherently tied to editing a file type/path
- **Create a rule** (`.cursor/rules/*.mdc`) when:
  - Guidance should **auto-apply** based on files being edited (via `globs`)
  - It’s a persistent policy/guardrail (e.g., “never silently use public RPC”)

If the user’s need is a rule, stop command authoring and pivot to `/add-new-rule` (briefly explain why).

## Question flow (ask 1–2 questions at a time)

Stop asking once you can produce a complete, deterministic command using the output template below.

### Phase 0 — classify (1–2 questions)

Ask:

1) **Is this an on-demand workflow (/command) or always-on editing guidance (rule)?**  
Options (single select): `command` / `rule` / `unsure`

If `rule` or `unsure`, ask one follow-up:

2) **What should activate it?**  
Options: `only when invoked` / `when editing specific paths` / `always`

Decision:

- If activation is “only when invoked” → proceed as **command**
- Otherwise → recommend a **rule** (brief why + point to `/add-new-rule`) and stop

### Phase 1 — define the command surface (2 questions)

Ask:

1) **Proposed command name + usage string?**  
Require: `kebab-case` name and a usage string with placeholders.

2) **List required args + optional flags (with defaults).**  
Require: validation rules (formats, allowed values, conflicts).

### Phase 2 — safety + prerequisites (1–2 questions)

Ask:

1) **Any actions that could be destructive / irreversible?**  
Options: `no` / `yes (describe)`

If yes, ask:

2) **Should the command ever perform writes (broadcast, push, deploy)?**  
Default: **no**. If user wants writes, require explicit opt-in flags and “confirm intent” language in the workflow.

### Phase 3 — repo alignment + sources of truth (1–2 questions)

Ask:

1) **Which repo artifacts should the command prefer?** (multi-select)  
Options: `config/networks.json`, `deployments/`, `config/whitelist.json`, `diamond.json`, `out/*/methodIdentifiers`, `other (specify)`

2) **What are the required env vars / tools?**  
Example: “premium RPC env var required; never silently fall back to public RPC”.

### Phase 4 — output contract (1–2 questions)

Ask:

1) **What is the exact output format?**  
Options: `markdown report`, `json artifact`, `terminal instructions`, `other (specify)`

2) **What are the mandatory sections/fields?**  
Example: “Inputs echo, steps performed, results, next actions, checklist”.

### Phase 5 — stop condition

Stop when you can fill all required fields in the “Output template for newly generated commands” below without guessing.

## Authoring checklist (for the produced command)

- **No duplication**: each concept appears once (avoid repeating inputs/safety in multiple sections)
- **Consistent terminology**: same names for args/flags/sections everywhere
- **Explicit defaults**: every optional flag has a default (and it’s stated)
- **Deterministic workflow**: step-by-step; no “do something like…”
- **Input schema + examples**: args/flags table + 2–3 examples
- **Explicit output format**: fixed template / sections
- **Quality checklist**: preflight + postflight checks
- **Token discipline**: summarize; avoid pasting huge traces/ABIs/source; prefer “extract key fields”

## Best practices (encode into the produced command)

- **Naming**: `kebab-case`, action verb, unambiguous; avoid repo-specific acronyms unless necessary
- **Usage clarity**: required args first; flags explicit; show conflicts (`--block` vs `--timestamp`)
- **Safety / guardrails**:
  - never silently fall back to public RPC if premium required
  - no destructive actions unless explicitly requested
  - state read-only defaults explicitly
- **Dependencies / prerequisites**: list env vars and required tooling up front; fail fast if missing
- **Repo-first alignment**: prefer canonical repo sources (`config/networks.json`, `deployments/`, `config/whitelist.json`, `diamond.json`, `out/*/methodIdentifiers`) when relevant

## Output template for newly generated commands

Use this exact skeleton and fill it in. Keep it concise; prefer tables and checklists over prose.

```markdown
---
name: <kebab-case-command-name>
description: <one line>
usage: /<command> <required_args...> [--flags...]
---

# <Title>

> **Usage**: `/<command> <required_args...> [--flags...]`
>
> Example: `/<command> ...`

## When to use this command

- <bullet>

## When NOT to use this command

- <bullet>

## Inputs (arguments + flags)

### Mandatory

- `<arg>`: <meaning + validation>

### Optional flags

| Flag | Default | Purpose | Validation / Conflicts |
|------|---------|---------|------------------------|
| `--foo <x>` | `<default>` | <purpose> | <rules> |

## Critical rules / guardrails (non-negotiable)

1. <rule>

## Workflow (deterministic)

### 1) Parse & validate inputs

- <steps>

### 2) Resolve dependencies / prerequisites

- <steps>

### 3) Execute the core workflow

- <steps>

## Output format

Produce:

```markdown
<explicit output template the assistant must follow>
```

## Quality checklist

- [ ] Inputs validated (formats + conflicts)
- [ ] Defaults applied explicitly
- [ ] Repo sources-of-truth used where applicable
- [ ] Output follows template exactly
- [ ] No huge dumps (trace/ABI/source); summarize key fields only
```

## Final steps (after generating the new command)

1. Add the new command file at `.cursor/commands/<command-name>.md`.
2. Update `.cursor/rules/README.md` “Custom Commands” table with the new entry (file, usage, purpose).
3. Optional: suggest testing by invoking the command (e.g., `/<command-name> --help` or a safe example).
