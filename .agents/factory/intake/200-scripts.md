---
name: TypeScript scripts
description: A script change is proven by a command the factory can run
areas: [scripts]
requires:
  - section: Acceptance criteria
    check: { command_matches: '^bun(x tsx)? ' }
    hint: At least one acceptance command runs through bun, e.g. `bun test script/foo.test.ts` or `bunx tsx script/foo.ts --dry-run`
  - section: Context
    check: mentions_path
    hint: Name the file or folder to start from, e.g. script/deploy/healthCheck.ts
---

The agent starts faster and wanders less when the ticket names where the change begins, and a
script change only counts as done when a `bun` command shows it.
