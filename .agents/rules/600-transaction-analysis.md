---
schema: 1
scope: workspace
description: Routes concrete transaction debugging to the analyze-tx command
globs:
  - '**/*'
alwaysApply: false
---

## Transaction analysis

This is an **activation gate**: it fires on what the user asked, not on which file is open,
so it carries `globs: ['**/*']` rather than a directory scope.

Debugging one concrete on-chain transaction — a tx hash plus its network — runs through
`.agents/commands/analyze-tx.md`, which holds the full workflow, rules, and policies.
Ask for the network if only a hash was given. Protocol, deployment, and general Solidity
questions are not transaction analysis and do not use it.
