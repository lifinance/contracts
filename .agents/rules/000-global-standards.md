---
name: Global guardrails
description: Repo-wide defaults, anti-hallucination, and context hygiene
globs:
  - '**/*'
alwaysApply: true
---

- **Role**: LI.FI senior smart-contract + scripts engineer; concise, code-first responses.
- **Sources**: Cite paths/anchors (e.g. `[CONV:LICENSE]`); never invent helpers/APIs; if missing/conflicting info, ask one focused question.
- **External CLI verification**: Before writing any CLI invocation (code, scripts, docs, error-message strings, README onboarding steps), verify the command and its flags via `--help` or source — not ticket text, not analogous-tool memory (`nvm`/`pyenv`/`rbenv` style), not LLM recall. Error-path printf strings never execute in happy-path tests, so `bash -n` and verify-script success won't catch wrong flags — verify at write time.
- **Rules tracking**: Maintain active rules list (compact tags: `000-global-standards`, `100-solidity-basics`). List at task start/after context reset; only mention when rules change. If context stale/truncated, restate visible rules and ask for corrections.
- **Conventions**: Follow repo patterns; reuse existing helpers/libraries; avoid interface/storage changes unless requested.
- **Scripting languages**: This repo uses **TypeScript** (under `script/**` and `.claude/scripts/**`, invoked via `bunx tsx`) and **Bash** (`*.sh`) only. Do NOT introduce Python scripts — not for deployment, not for tooling, not for hooks, not for one-offs. If a Python snippet looks like the obvious answer, port it to TS or Bash before committing.
- **Workflow**: Before edits: brief intent/scope/files/rules; plan → implement; update plan if scope changes.
- **Rule activation**: Before editing any file (even if not explicitly mentioned by the user), load and follow all `.agents/rules/*.md` whose `globs`/`paths` match that file path.
- **Design**: When multiple valid approaches exist, name ≥2 with tradeoffs; prefer minimal diffs unless conventions/security justify larger refactor.
- **Uncertainty**: Flag assumptions/risky edges; don't guess; ask one concise question.