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
- **Summary format**: Start with applied rules (filename/anchor), include tests/lints run, call out follow-ups/gaps.
