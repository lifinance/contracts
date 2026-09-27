---
name: Scripts
description: A script change is proven by a command the factory can run
areas: [scripts]
requires:
  - section: Acceptance criteria
    check: { command_matches: '^(bunx? |bash |forge )' }
    hint: At least one acceptance command the factory can run, e.g. `bun test script/foo.test.ts`, `bash -n script/foo.sh` or `forge build`
  - section: Context
    check: mentions_path
    hint: Name the file or folder to start from, e.g. script/deploy/healthCheck.ts
---

The agent starts faster and wanders less when the ticket names where the change begins, and a
script change only counts as done when a command the factory can run shows it.
