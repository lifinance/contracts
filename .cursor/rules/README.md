# Cursor Rules Structure

This directory contains rule files (`.mdc` format) that guide the AI assistant's behavior when working with this codebase.

## Rule File Naming

Rules are numbered for ordering by category (**numeric prefixes must be unique**):

- `000-099`: Global/standards rules (always-applied: context monitoring, guardrails, architecture, project structure, final checks)
- `100-199`: Solidity-related rules (basics, contracts, facets, interfaces, receivers, security, gas, scripts)
- `200-299`: TypeScript-related rules (scripts, helpers, conventions)
- `300-399`: Bash-related rules (deployment scripts, shell utilities)
- `400-499`: Testing-related rules (Solidity tests, TS tests, testing patterns, coverage)
- `500-599`: Git/GitHub Actions + audit-process rules (CI/CD workflows, audit log/report management)
- `600-699`: Mixed/other rules (transaction analysis, cross-cutting concerns)

## Rule File Format

Each rule file uses MDC (Markdown with frontmatter):

```markdown
---
name: Rule name
description: Brief description
globs:
  - 'pattern/**/*.sol'
alwaysApply: true # Optional, only for critical global rules
---

Rule content here...
```

## Rule Activation

- **alwaysApply: true**: Rule is always included in context (use sparingly)
- **globs**: Rule activates when files matching patterns are referenced

## Conventions Integration

Rules reference conventions via `[CONV:*]` anchors that are defined directly within the cursor rules files. All convention content has been consolidated into the rule files themselves.

## Best Practices

1. **Keep rules focused**: One concern per rule file
2. **Use [CONV:*] anchors**: Reference convention anchors defined within rule files for consistency
3. **Use specific globs**: Target file types precisely to avoid unnecessary activation
4. **Minimize alwaysApply**: Only use for truly global rules (generally within `000-099`)
5. **Self-contained**: All convention content is embedded in rule files; no external MD file dependencies

## Context Management

- `003-context-monitor.mdc`: Monitors context window usage, warns when approaching limits, and handles information rollover/handoff

## Adding New Rules

Use `/add-new-rule` as the standard workflow.

If you’re making changes manually:

1. Choose appropriate number range (see naming above)
2. Create `.mdc` file with frontmatter
3. Define specific globs (avoid `**/*` unless truly global)
4. Reference conventions via `[CONV:*]` anchors
5. Test that rule activates appropriately
6. Update this README if adding new category, rule, or command

## Custom Commands

Custom commands live in `.cursor/commands/` and are invoked via `/...` in Cursor chat.

| Command File      | Usage                             | Purpose                                                                                      |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `add-new-rule.md` | `/add-new-rule`                   | Standard workflow for adding/updating rules & commands (scoping, dedupe, naming, validation) |
| `add-audit.md`    | `/add-audit`                      | Add an audit PDF + update `audit/auditLog.json`                                              |
| `analyze-tx.md`   | `/analyze-tx <network> <tx_hash>` | Transaction trace/runbook analysis for a specific tx                                         |

## Transaction Analysis

Special handling for transaction analysis:

- `600-transaction-analysis.mdc`: Activation gate (detects natural language queries)
- `.cursor/commands/analyze-tx.mdc`: Complete analysis workflow, rules, and policies (single source of truth)

Users can either use the `/analyze-tx <network> <tx_hash>` command directly or trigger analysis mode through natural language queries (e.g., "analyze this transaction 0x123... on ethereum").

## Current Rule Files

| File                           | Description                                                     | Auto-Apply  | Glob Patterns                                                                                                 |
| ------------------------------ | --------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `000-global-standards.mdc`     | Project-wide conventions and guardrails                         | ✅ Always   | -                                                                                                             |
| `001-project-structure.mdc`    | Project structure and file placement guidance                   | ✅ Always   | -                                                                                                             |
| `002-architecture.mdc`         | Core architectural principles (Diamond, separation, governance) | ✅ Always   | -                                                                                                             |
| `003-context-monitor.mdc`      | Context window monitoring and handoff management                | ✅ Always   | -                                                                                                             |
| `099-finish.mdc`               | Completion checklist to keep repo green                         | ✅ Always   | -                                                                                                             |
| `100-solidity-basics.mdc`      | Baseline rules for all Solidity files                           | ❌ On match | `**/*.sol`                                                                                                    |
| `101-solidity-contracts.mdc`   | Production Solidity contracts/interfaces in src                 | ❌ On match | `src/**/*.sol`, `!src/**/*.s.sol`, `!src/**/*.t.sol`                                                          |
| `102-facets.mdc`               | Facet-only requirements and validations                         | ❌ On match | `src/Facets/**/*.sol`                                                                                         |
| `103-solidity-interfaces.mdc`  | Interface-only rules for Solidity interfaces                    | ❌ On match | `src/Interfaces/**/*.sol`                                                                                     |
| `104-receiver-contracts.mdc`   | Receiver contract requirements and patterns                     | ❌ On match | `src/Periphery/Receiver*.sol`                                                                                 |
| `105-security.mdc`             | Cross-cutting security expectations                             | ❌ On match | `src/**/*.sol`, `script/**/*.sol`, `script/**/*.ts`, `test/**/*.t.sol`                                        |
| `106-gas.mdc`                  | Gas-efficiency guidance aligned with existing patterns          | ❌ On match | `src/**/*.sol`                                                                                                |
| `107-solidity-scripts.mdc`     | Foundry deployment/update script patterns                       | ❌ On match | `script/**/*.s.sol`, `script/**/*.sol`                                                                        |
| `200-typescript.mdc`           | TS scripting, helpers, lint/tests                               | ❌ On match | `script/**/*.ts`, `tasks/**/*.ts`                                                                             |
| `300-bash.mdc`                 | Deployment bash structure and safety                            | ❌ On match | `**/*.sh`                                                                                                     |
| `400-solidity-tests.mdc`       | Foundry test structure, naming, and expectations                | ❌ On match | `test/**/*.t.sol`                                                                                             |
| `401-testing-patterns.mdc`     | Cross-language testing, coverage, and structure                 | ❌ On match | `test/**/*.t.sol`, `**/*.test.ts`, `script/**/*.ts`                                                           |
| `402-typescript-tests.mdc`     | Bun test structure and expectations for `.test.ts`              | ❌ On match | `**/*.test.ts`                                                                                                |
| `500-github-actions.mdc`       | GitHub Actions workflows structure and conventions              | ❌ On match | `.github/workflows/**/*.yml`, `.github/workflows/**/*.yaml`, `.github/**/*.yml`, `.github/**/*.yaml`          |
| `501-audits.mdc`               | Audit log and audit report management                           | ❌ On match | `audit/**/*.json`, `audit/**/*.pdf`, `.github/workflows/**/*audit*.yml`, `.github/workflows/**/*version*.yml` |
| `502-git-workflow.mdc`         | Git workflow, branching strategy, and PR targeting conventions  | ❌ On match | `.git/**`, `.github/pull_request_template.md`, `.github/**/*.md`, `**/*.md`                                   |
| `600-transaction-analysis.mdc` | Transaction analysis activation gate                            | ❌ On match | `**/*`                                                                                                        |
