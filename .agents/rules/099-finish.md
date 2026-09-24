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
- **Health-check invariants**: If you added, removed, or changed a facet or periphery contract, confirm `script/deploy/healthCheckInvariants.ts` was reviewed for needed invariant changes (see `601-healthcheck-invariants`). If it binds an external protocol address immutably, confirm the constructor arg carries a `getter` annotation in `deployRequirements.json`. Every immutable the contract introduces also needs an entry in `script/deploy/resources/immutableRegistry.json`, or `verify-immutable-registry --strict` fails CI.
- **PR review feedback**: Walk the full diff yourself before pinging for review — that is the local gate, and there is no local CodeRabbit step. Cloud CodeRabbit runs in GitHub CI on every PR and is the review backstop.
- **After opening a PR**: don't abandon it — watch CI checks and bot reviewers (cloud CodeRabbit, Aikido) and resolve failures or actionable comments before requesting human review. Once the PR is handed off for review, clean up the session workspace: remove the worktree (if one was used) and any stray uncommitted files so the next session starts from a clean bench.
- **Summary format**: State which tests and linters were run and their result, and call out follow-ups and gaps. Cite a rule anchor only where it explains a choice the reader would otherwise question.
