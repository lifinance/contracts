# Cursor Rules Structure

This directory contains rule files (markdown with YAML frontmatter) that guide the AI assistant's behavior when working with this codebase. Source files are `.md`; symlinked into `.cursor/rules/` as `.mdc` (Cursor convention) and `.claude/rules/` as `.md` (Claude Code convention).

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

Each rule file uses Markdown with YAML frontmatter. The `globs` and `alwaysApply` fields are read by Cursor; `paths` is read by Claude Code. Include both for tools to behave consistently.

```markdown
---
name: Rule name
description: Brief description
globs:
  - 'pattern/**/*.sol'
paths:
  - 'pattern/**/*.sol'
alwaysApply: true # Optional, Cursor-only; for critical global rules
---

Rule content here...
```

## Rule Activation

- **alwaysApply: true**: Rule is always included in context (use sparingly)
- **globs**: Rule activates when files matching patterns are referenced

## Conventions Integration

Rules reference conventions via `[CONV:*]` anchors that are defined directly within the cursor rules files. All convention content has been consolidated into the rule files themselves.

## Best Practices

All authoring constraints (scoping, size, naming, no-duplication, conventions, cross-references) are enforced automatically by `010-agents-authoring` (activates when editing `.agents/rules/*.md` or `.agents/commands/*.md`).

## Context Management

- `003-context-monitor.md`: Monitors context window usage, warns when approaching limits, and handles information rollover/handoff

## Adding New Rules

Use `/add-rule-or-skill` as the standard workflow — it covers symlink creation, frontmatter, scoping, and validation.

## Custom Commands

Custom commands live in `.agents/commands/` (source of truth) and are symlinked into `.cursor/commands/` (Cursor) and `.claude/skills/` (Claude Code).

| Command File      | Usage                             | Purpose                                                                                      |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `add-audit.md`    | `/add-audit`                      | Add an audit PDF + update `audit/auditLog.json`                                              |
| `add-network.md`  | `/add-network [networkKey]`       | Add a new network (networks.json, foundry.toml, permit2Proxy.json, gaszip.json, bridge configs) |
| `add-rule-or-skill.md` | `/add-rule-or-skill`         | Standard workflow for adding/updating rules & commands (scoping, dedupe, naming, validation, **skill-authoring principles**) |
| `aikido-address-findings.md` | `/aikido-address-findings [<issue-id> \| all \| pr] [repo-name]` | Aikido triage scoped to the PR (default), a single finding, or the whole repo — ignore false positives, fix real findings in code |
| `aikido-update-false-positive-catalog.md` | `/aikido-update-false-positive-catalog <file-path> <rule-name>` | Add a new false positive pattern to the catalog so aikido-address-findings auto-ignores it on future runs |
| `analyze-tx.md`   | `/analyze-tx <network> <tx_hash>` | Transaction trace/runbook analysis for a specific tx                                         |
| `analyze-unverified-contract.md` | `/analyze-unverified-contract <address> <network>` | Investigate an unverified contract — resolve RPC, detect proxies, disassemble, enumerate selectors, emit a report |
| `check-open-prs.md` | `/check-open-prs`               | Personal PR dashboard — own PRs + incoming review queue via the deterministic `script/utils/check-open-prs.ts` collector, with Slack cross-reference only for ambiguous PRs |
| `check-rotation-status.md` | `/check-rotation-status --old-address 0xOLD --new-address 0xNEW [--role deployer\|dev\|pauser] [--removed-signer 0x] [--network <csv>] [--production]` | Read-only cross-network completeness gate for a wallet rotation/offboarding — Safe-owner membership, Timelock `CANCELLER_ROLE`, whitelist, staging `owner()`, funding; generalizes the hardcoded `temp/checkOffboardingStatusPerNetwork.ts` into a flag-driven checker |
| `create-pr.md`    | `/create-pr`                      | Create a PR for the current branch (branch/commit/push) using the repo PR template; requires an assigned, estimated EXSC Linear ticket unless the user explicitly opts out |
| `deploy-contract.md` | `/deploy-contract <Contract> <network...> [--production]` | Deploy a facet/periphery to networks + register in each LiFiDiamond (verify, diamondCut/diamondUpdatePeriphery, periphery allowlist). Staging/test terminal path and the deploy primitive `multisig-rollout` calls; production rollouts go through `multisig-rollout`. Routes Tron targets to `deploy-contract-tron` |
| `deploy-contract-tron.md` | `/deploy-contract-tron <Contract> <tron\|tronshasta...>` | Deploy a facet/periphery to Tron from the `contracts-tron` fork — sync/delta preflight, `-tron` versioning, TronWeb deploy scripts, Tronscan verify, deploy-log PR against **upstream** `contracts` |
| `deprecate-contract.md` | `/deprecate-contract <Name> ...` | Deprecate facet/periphery contracts by removing them from the codebase                  |
| `deprecate-network.md`  | `/deprecate-network <net> ...`   | Deprecate networks — remove from networks.json, foundry.toml, deployment logs            |
| `finish-rollout.md` | `/finish-rollout <slack thread link>` | Finish a production rollout after timelock execution — verify (timelock queue + on-chain), dispatch the Timelock Auto Execution workflow if ops are ready-but-unexecuted, close the `#dev-sc-multisig-proposals` thread, sync diamond logs onto the rollout PR, `/pr-ready` → ready → `/post-pr-for-review`. The tail of `multisig-rollout` |
| `interact-tron.md` | `/interact-tron <call\|send\|address\|code> ...` | Read/write Tron contract state via `troncast` (the `cast` analog for Tron) — calls, sends, address conversion, bytecode; routing target for EVM skills that hit a Tron network |
| `manage-wallet-funds.md` | `/manage-wallet-funds <bridge\|swap\|send> --wallet <role\|0x> ...` | Move funds from any `.env` wallet — `bridge`/`swap` route via the LI.FI API (same wallet, autonomous), `send` is a direct native transfer to a different recipient (needs an explicit human `--confirm`); wallet resolved by role or address (EVM) |
| `move-tron-delegation.md` | `/move-tron-delegation --old-address 0xOLD --new-address 0xNEW [--role dev\|deployer]` | Move Tron staked-resource (energy/bandwidth) delegation from a rotated-out wallet's Tron address to the new one — derive base58 pair, draft the provider (Max) request, verify on Tronscan; delegator-controlled, never signed from our keys |
| `multisig-rollout.md` | `/multisig-rollout <Contract> \| --whitelist-pr <N>` | Orchestrate a production rollout: deploy (delegated to `deploy-contract`) or whitelist-sync across chains, Safe proposals, opt-in stale-facet removal, draft PR, signing hand-off, signature verification, `#dev-sc-multisig-proposals` thread |
| `offboard-sc-dev.md` | `/offboard-sc-dev --person <name> --removed-signer 0x --new-signer 0x [--linear EXSC-XXX]` | Orchestrate a full SC-team offboarding — swap the departing multisig signer and rotate all three shared wallets (deployer/dev/pauser); v1 execute-only, drives the rotate-* skills + `multisig-rollout`, gates on `check-rotation-status` |
| `post-pr-for-review.md` | `/post-pr-for-review`            | Post a PR to `#dev-sc-review`, enable auto-merge (squash), tag `@smartcontract_core`     |
| `request-audit.md` | `/request-audit <PR_NUMBER_OR_URL> [--urgent]` | Prepare and send a smart contract audit request to Slack (Sujith or burrasec team)       |
| `request-dev-funds.md` | `/request-dev-funds`            | Request dev funds via the `automate-wallet-dev-fees` PR-based wallet (EVM + Solana)        |
| `resolve-audit-issues.md` | `/resolve-audit-issues <PR_NUMBER_OR_URL_OR_FACET> [--audit-repo <owner/repo>]` | Work through an auditor's GitHub findings for a contracts PR — discover the audit repo from Slack, load every issue, triage fix-vs-acknowledge in one gate, fix each on a remediation branch (one commit per finding), reply `fixed <commit>` / `acknowledged <reason>` on each issue |
| `review-bounty-report.md` | `/review-bounty-report`       | Review Cantina bug bounty report vs codebase, docs, audits, scope, severity (log output only) |
| `rotate-deployer-wallet.md` | `/rotate-deployer-wallet [--new-address 0xNEW] [--check]` | Rotate the SC-owned Deployer wallet (`safeOwners[0]` + Timelock `CANCELLER_ROLE`) end-to-end — bootstrap gas, Safe owner swap + canceller move via `multisig-rollout`, Tron, config PR, key decommission; heaviest-governance rotation |
| `rotate-dev-wallet.md` | `/rotate-dev-wallet [--new-address 0xNEW] [--check]` | Rotate the SC-owned Dev wallet (staging LiFiDiamond owner) end-to-end — sweep gas, transfer staging ownership, move Tron delegation, config PR, completeness check; lowest-stakes rotation and the reference orchestrator |
| `rotate-pauser-wallet.md` | `/rotate-pauser-wallet [--new-address 0xNEW] [--check]` | Rotate the SC-owned Pauser EOA — redeploy `EmergencyPauseFacet` with the new pauser (immutable, no setter) and `diamondCut` into every diamond via `deploy-contract`/`multisig-rollout`, sweep old, rotate CI secret, config PR |
| `sweep-wallet-funds.md` | `/sweep-wallet-funds --new-address 0xNEW [--old-key-env PRIVATE_KEY_PRODUCTION] [--production] [--check]` | Multi-chain native-gas sweep from a rotated-out SC wallet to its replacement via `moveNativeFundsToNewWallet.ts` — dry-run preview, key-derived sender, human-confirmed report; the funding primitive every rotation calls |
| `update-wallet-config.md` | `/update-wallet-config --role <deployer\|dev\|pauser> --new-address 0xNEW [--production]` | Open the PR that rotates a wallet role in `config/global.json` (EVM field + matching `tronWallets.<role>` base58, Tron address derived + round-trip-checked); config-only, delegates to `/create-pr` |
| `verify-contracts.md` | `/verify-contracts <network> \| PR #<N>` | Verify a network's deployed contracts on its block explorer and flip the MongoDB `verified` flag for each |

## Transaction Analysis

Special handling for transaction analysis:

- `600-transaction-analysis.md`: Activation gate (detects natural language queries)
- `.agents/commands/analyze-tx.md`: Complete analysis workflow, rules, and policies (source of truth)

Users can either use the `/analyze-tx <network> <tx_hash>` command directly or trigger analysis mode through natural language queries (e.g., "analyze this transaction 0x123... on ethereum").

## Current Rule Files

| File                           | Description                                                      | Auto-Apply  | Glob Patterns                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `000-global-standards.md`     | Project-wide conventions and guardrails                          | ✅ Always   | -                                                                                                             |
| `001-project-structure.md`    | Project structure and file placement guidance                    | ✅ Always   | -                                                                                                             |
| `002-architecture.md`         | Core architectural principles (Diamond, separation, governance)  | ✅ Always   | -                                                                                                             |
| `003-context-monitor.md`      | Context window monitoring and handoff management                 | ✅ Always   | -                                                                                                             |
| `004-config-structure.md`     | Config JSON structure (key-first vs network-first), deploy paths | ❌ On match | `config/**/*.json`, `script/deploy/**/*.s.sol`, `script/deploy/resources/deployRequirements.json`             |
| `010-agents-authoring.md`     | Auto-enforced constraints when editing .agents/ rules or commands | ❌ On match | `.agents/rules/*.md`, `.agents/commands/*.md`                                                                 |
| `099-finish.md`               | Completion checklist to keep repo green                          | ✅ Always   | -                                                                                                             |
| `100-solidity-basics.md`      | Baseline rules for all Solidity files                            | ❌ On match | `**/*.sol`                                                                                                    |
| `101-solidity-contracts.md`   | Production Solidity contracts/interfaces in src                  | ❌ On match | `src/**/*.sol`, `!src/**/*.s.sol`, `!src/**/*.t.sol`                                                          |
| `102-facets.md`               | Facet-only requirements and validations                          | ❌ On match | `src/Facets/**/*.sol`                                                                                         |
| `103-solidity-interfaces.md`  | Interface-only rules for Solidity interfaces                     | ❌ On match | `src/Interfaces/**/*.sol`                                                                                     |
| `104-receiver-contracts.md`   | Receiver contract requirements and patterns                      | ❌ On match | `src/Periphery/Receiver*.sol`                                                                                 |
| `105-security.md`             | Cross-cutting security expectations                              | ❌ On match | `src/**/*.sol`, `script/**/*.sol`, `script/**/*.ts`, `test/**/*.t.sol`                                        |
| `106-gas.md`                  | Gas-efficiency guidance aligned with existing patterns           | ❌ On match | `src/**/*.sol`                                                                                                |
| `107-solidity-scripts.md`     | Foundry deployment/update script patterns                        | ❌ On match | `script/**/*.s.sol`, `script/**/*.sol`                                                                        |
| `200-typescript.md`           | TS scripting, helpers, lint/tests                                | ❌ On match | `script/**/*.ts`, `tasks/**/*.ts`                                                                             |
| `201-safe-decode-scripts.md`  | Safe/timelock decode & display conventions                       | ❌ On match | `script/deploy/safe/**/*.ts`                                                                                  |
| `202-tron-scripts.md`         | Tron-specific TS conventions (TronWeb, address handling)         | ❌ On match | `script/deploy/tron/**/*.ts`, `script/troncast/**/*.ts`                                                       |
| `300-bash.md`                 | Deployment bash structure and safety                             | ❌ On match | `**/*.sh`                                                                                                     |
| `400-solidity-tests.md`       | Foundry test structure, naming, and expectations                 | ❌ On match | `test/**/*.sol`                                                                                               |
| `401-testing-patterns.md`     | Cross-language testing, coverage, and structure                  | ❌ On match | `test/**/*.t.sol`, `**/*.test.ts`, `script/**/*.ts`                                                           |
| `402-typescript-tests.md`     | Bun test structure and expectations for `.test.ts`               | ❌ On match | `**/*.test.ts`                                                                                                |
| `500-github-actions.md`       | GitHub Actions workflows structure and conventions               | ❌ On match | `.github/workflows/**/*.yml`, `.github/workflows/**/*.yaml`, `.github/**/*.yml`, `.github/**/*.yaml`          |
| `501-audits.md`               | Audit log and audit report management                            | ❌ On match | `audit/**/*.json`, `audit/**/*.pdf`, `.github/workflows/**/*audit*.yml`, `.github/workflows/**/*version*.yml` |
| `502-whitelist-branching.md`  | Whitelist config branching strategy (main branch only)           | ❌ On match | `config/whitelist.json`, `config/composerWhitelist.json`                                                      |
| `600-transaction-analysis.md` | Transaction analysis activation gate                             | ❌ On match | `**/*`                                                                                                        |
