---
name: Final checks
description: Completion checklist to keep repo green
globs:
  - '**/*'
alwaysApply: true
---

**Scope**: This checklist applies to **every file you create or modify** during the task, including files you added or edited that were not mentioned in the user’s initial prompt. Before finalizing, run the relevant checks on all such files.

- **Conventions**: Verify `[CONV:LICENSE]`/`[CONV:NATSPEC]`/`[CONV:BLANKLINES]`/`[CONV:NAMING]` satisfied; avoid interface/storage changes unless requested.
- **Testing**: After Solidity changes → `forge test` (or note suites remaining); after TS → lint/tests with Bun; after Bash → check execution flags/sourcing. State explicitly if anything not run.
- **Linting**: Run the relevant linter on **all files you created or edited** (e.g. `bunx eslint` for TS/JS, or the project’s lint command) and fix all reported issues before finalizing. Do not claim the code is free of lint errors unless the linter has been run on those files and exited successfully.
- **PR-ready (mandatory final step before opening or updating a PR)**: Run `/pr-ready` to execute a local CodeRabbit review against the current branch and resolve all actionable findings before pushing. This applies to humans and agents alike. Do **not** run `gh pr create`, mark a draft as Ready for Review, or push new commits to an open PR until the local review is clean (or remaining items are explicitly documented in the PR body). See `.agents/commands/pr-ready.md` for the full workflow. Do not bypass with `--no-verify` or similar escape hatches.
- **Summary format**: Start with applied rules (filename/anchor), include tests/lints run, confirm `/pr-ready` was executed (or explain why not), call out follow-ups/gaps.
