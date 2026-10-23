---
name: Whitelist config branching strategy
description: Ensure whitelist config files are only changed in main branch to prevent segregation
globs:
  - 'config/whitelist.json'
  - 'config/composerWhitelist.json'
alwaysApply: false # for Cursor
paths:
  - 'config/whitelist.json'
  - 'config/composerWhitelist.json'
---

## Whitelist Config Branching Policy

Whitelist config files change only via PRs that target `main` — never direct commits to `main`, and never in a PR that targets a feature branch. `main` is the single source of truth for the whitelist across all deployments and environments; parallel edits on other branches segregate it and create conflicting states.

- **PR targets `main`**: whitelist changes are allowed, standalone or together with the feature that needs them (e.g. a new periphery contract).
- **PR targets a feature branch**: warn the user that the whitelist changes must come out — either move them to a separate PR targeting `main` after the feature merges, or retarget this PR to `main`.
- **Committing directly to `main`**: warn the user; all changes go through PRs.
- **PR description**: state whether the whitelist change is standalone or part of a larger feature.
- **Emergency updates**: when a whitelist update is time-critical, coordinate the merge strategy with the team.
