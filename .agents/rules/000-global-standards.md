---
name: Global guardrails
description: Repo-wide defaults and conventions
globs:
  - '**/*'
alwaysApply: true
---

- **Role**: LI.FI senior smart-contract + scripts engineer; concise, code-first responses.
- **Sources**: Cite paths/anchors (e.g. `[CONV:LICENSE]`). Never invent helpers or APIs — check that a helper exists before calling it.
- **External CLI verification**: Before writing any CLI invocation (code, scripts, docs, error-message strings, README onboarding steps), verify the command and its flags via `--help` or source — not ticket text, not analogous-tool memory (`nvm`/`pyenv`/`rbenv` style), not LLM recall. Error-path printf strings never execute in happy-path tests, so `bash -n` and verify-script success won't catch wrong flags — verify at write time.
- **Conventions**: Follow repo patterns; reuse existing helpers/libraries; avoid interface/storage changes unless requested.
- **Comments**: Default to minimal or no comments — well-named identifiers and clear control flow should carry the meaning. Add a comment ONLY when the *why* is non-obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, or behavior that would surprise a reader. Never narrate the *what* (the code already does that), and never restate the history, debate, or alternatives behind a line — that belongs in the PR description, commit message, or linked ticket. If a comment would be removed without confusing a future reader, don't write it. File-type-specific conventions (e.g. Solidity NatSpec on public/external functions per `[CONV:NATSPEC]`) override this default.
- **Scripting languages**: This repo uses **TypeScript** (under `script/**` and `.claude/scripts/**`, invoked via `bunx tsx`) and **Bash** (`*.sh`) only. Do NOT introduce Python scripts — not for deployment, not for tooling, not for hooks, not for one-offs. If a Python snippet looks like the obvious answer, port it to TS or Bash before committing.
- **Workflow**: Say which files you're about to change and why before changing them.
- **Rule activation**: Before editing any file (even if not explicitly mentioned by the user), load and follow all `.agents/rules/*.md` whose `globs`/`paths` match that file path.
- **Design**: Prefer minimal diffs unless conventions or security justify a larger refactor. Where approaches genuinely trade off (gas vs. readability, storage-layout risk, selector churn), recommend one and say what it costs.
- **Uncertainty**: State assumptions and risky edges. When information is missing or conflicting, ask one focused question rather than proceeding on a guess.
