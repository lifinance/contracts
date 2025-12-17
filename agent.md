# LI.FI Contracts — Agent Instructions (Cursor-distilled)

## 1) Title + Scope

- This file is a **distilled, repo-specific runbook** for making changes in `/contracts` safely and consistently. (.cursor/rules/000-global-standards.mdc)
- It covers **Solidity (`src/`, `script/**/_.s.sol`, `test/\*\*/_.t.sol`)**, **TypeScript scripts/tests**, **Bash scripts**, **CI workflows**, and **audit artifacts\*\*. (.cursor/rules/001-project-structure.mdc)
- It does **not** replace the full rule text; when in doubt, follow the authoritative sources below. (.cursor/rules/000-global-standards.mdc)
- **Authoritative sources**: `.cursor/rules/*.mdc`, `.cursor/commands/*.mdc`, and `conventions.md` (high-level rationale). (.cursor/rules/README.md) (conventions.md)

## 2) Active Rules Index (how this repo “thinks”)

### Rule tags (compact)

- `000-global-standards`: role, sourcing, minimal diffs, uncertainty handling. (.cursor/rules/000-global-standards.mdc)
- `001-project-structure`: where code lives + remappings. (.cursor/rules/001-project-structure.mdc)
- `002-architecture`: Diamond/separation/governance/events invariants. (.cursor/rules/002-architecture.mdc)
- `003-context-monitor`: context/handoff policy. (.cursor/rules/003-context-monitor.mdc)
- `099-finish`: final checks + “what tests did you run” reporting. (.cursor/rules/099-finish.mdc)
- `100-solidity-basics`: SPDX/pragma/NatSpec/naming/errors/blanklines. (.cursor/rules/100-solidity-basics.mdc)
- `101-solidity-contracts`: production `src/` caution + NatSpec + diamond/lib reuse. (.cursor/rules/101-solidity-contracts.mdc)
- `102-facets`: facet entrypoints/modifiers/validation + non-EVM + positive slippage. (.cursor/rules/102-facets.mdc)
- `103-solidity-interfaces`: `src/Interfaces` rules. (.cursor/rules/103-solidity-interfaces.mdc)
- `104-receiver-contracts`: `src/Periphery/Receiver*.sol` patterns. (.cursor/rules/104-receiver-contracts.mdc)
- `105-security`: cross-cutting input/config validation + governance safety. (.cursor/rules/105-security.mdc)
- `106-gas`: safe gas guidance. (.cursor/rules/106-gas.mdc)
- `107-solidity-scripts`: deploy/update script patterns + zksync sync. (.cursor/rules/107-solidity-scripts.mdc)
- `200-typescript`: TS scripting conventions (viem-only, helpers, tests). (.cursor/rules/200-typescript.mdc)
- `300-bash`: Bash deployment safety + structure. (.cursor/rules/300-bash.mdc)
- `400-solidity-tests`: Foundry test structure + naming + assertions. (.cursor/rules/400-solidity-tests.mdc)
- `401-testing-patterns`: cross-language testing discipline + reporting. (.cursor/rules/401-testing-patterns.mdc)
- `402-typescript-tests`: Bun test expectations. (.cursor/rules/402-typescript-tests.mdc)
- `500-github-actions`: workflow conventions. (.cursor/rules/500-github-actions.mdc)
- `501-audits`: audit log/report rules. (.cursor/rules/501-audits.mdc)
- `600-transaction-analysis`: activation gate for tx-analysis mode. (.cursor/rules/600-transaction-analysis.mdc)

### Activation map (what applies when you touch X)

- `src/Facets/**`: `100`, `101`, `102`, `105`, `106` (+ always-apply `000/001/002/003/099`). (.cursor/rules/README.md)
- `src/Periphery/Receiver*.sol`: `100`, `101`, `104`, `105`, `106` (+ always-apply). (.cursor/rules/README.md)
- `src/Interfaces/**`: `100`, `103` (+ always-apply; also `105/106` when relevant via globs). (.cursor/rules/README.md)
- `script/**/*.s.sol`: `100`, `107`, `105` (+ always-apply). (.cursor/rules/README.md)
- `script/**/*.ts`, `tasks/**/*.ts`: `200` (+ `105` when applicable) (+ always-apply). (.cursor/rules/README.md)
- `test/**/*.t.sol`: `100`, `400`, `401` (+ `105` via globs) (+ always-apply). (.cursor/rules/README.md)
- `**/*.test.ts`: `401`, `402` (+ always-apply). (.cursor/rules/README.md)
- `.github/workflows/**`: `500` (+ always-apply). (.cursor/rules/README.md)
- `audit/**`: `501` (+ always-apply). (.cursor/rules/README.md)

## 3) Repo Map + Where Things Go

- **Facets**: `src/Facets/` (Diamond entrypoints; keep thin; delegate to libs). (.cursor/rules/001-project-structure.mdc) (.cursor/rules/002-architecture.mdc)
- **Periphery**: `src/Periphery/` (standalone helpers called by Diamond). (.cursor/rules/001-project-structure.mdc)
- **Helpers**: `src/Helpers/` (inheritable utilities; not deployed directly). (.cursor/rules/001-project-structure.mdc)
- **Libraries**: `src/Libraries/` (stateless shared logic like `LibAsset`, `LibSwap`). (.cursor/rules/001-project-structure.mdc)
- **Interfaces**: `src/Interfaces/` (external protocol + IERC\*). (.cursor/rules/001-project-structure.mdc)
- **Tests**: `test/solidity/` mirrors `src/`. (.cursor/rules/400-solidity-tests.mdc)
- **Scripts**: `script/` (Solidity deploy/update under `script/deploy/**`; TS demos under `script/demoScripts/**`). (.cursor/rules/001-project-structure.mdc)
- **Remappings**: use `lifi/` → `src/` and `test/` → `test/` per `remappings.txt`. (.cursor/rules/001-project-structure.mdc)

## 4) Golden Rules (Non-negotiables)

- **Never invent helpers/APIs**; cite exact repo sources/anchors, and ask one focused question if info is missing/conflicting. (.cursor/rules/000-global-standards.mdc)
- Solidity files **must** use `// SPDX-License-Identifier: LGPL-3.0-only` and `pragma solidity ^0.8.17;` (no blank line between) for LI.FI-owned code. (.cursor/rules/100-solidity-basics.mdc [CONV:LICENSE])
- Contracts/interfaces **must** include NatSpec header tags: `@title`, `@author LI.FI (https://li.fi)`, `@notice`, `@custom:version X.Y.Z`. (.cursor/rules/100-solidity-basics.mdc [CONV:NATSPEC]) (.cursor/rules/101-solidity-contracts.mdc)
- Governance controls (Safe + timelock) **must never** be bypassed or weakened. (.cursor/rules/002-architecture.mdc [CONV:ARCH-GOVERNANCE]) (.cursor/rules/105-security.mdc)
- Selector layout + storage layout **must** be treated as upgrade-critical invariants. (.cursor/rules/002-architecture.mdc [CONV:ARCH-DIAMOND])
- `LiFiTransferStarted` **must** be emitted at the end of facet `_startBridge` (after validations + external calls). (.cursor/rules/002-architecture.mdc [CONV:EVENTS])
- `LiFiTransferCompleted` **must only** be emitted by `src/Periphery/Executor.sol`. (.cursor/rules/002-architecture.mdc [CONV:EVENTS])
- `LiFiTransferRecovered` **must only** be emitted by receiver contracts (`src/Periphery/Receiver*.sol`). (.cursor/rules/002-architecture.mdc [CONV:EVENTS]) (.cursor/rules/104-receiver-contracts.mdc)
- When multiple valid approaches exist, you **must** name ≥2 options with tradeoffs and pick the repo-preferred one. (.cursor/rules/000-global-standards.mdc)

## 5) Workflow: How to Work in This Repo (agent runbook)

- Start by stating **intent, scope, files, and active rule tags**. (.cursor/rules/000-global-standards.mdc)
- Implement with **minimal diffs** and reuse existing patterns/libs/helpers first. (.cursor/rules/000-global-standards.mdc) (.cursor/rules/002-architecture.mdc) (.cursor/rules/200-typescript.mdc)
- Validate inputs/config explicitly (contracts + scripts). (.cursor/rules/105-security.mdc)
- After changes, **run the appropriate tests** or explicitly state what you did not run. (.cursor/rules/099-finish.mdc) (.cursor/rules/401-testing-patterns.mdc)
  - Example commands (pick what fits the change; avoid unnecessary project-wide runs): `forge test`, `bun lint`, `bun test:ts`. ([AGENTS.md best practices](https://agentsmd.io/agents-md-best-practices))
- Final response **must** start with applied rule citations and include tests/lints run + gaps/follow-ups. (.cursor/rules/099-finish.mdc)

## 6) Solidity Guidelines (by file type)

### Production contracts in `src/`

- You **must not** modify production contracts in `src/` unless explicitly requested. (.cursor/rules/101-solidity-contracts.mdc)
- You **must** prefer existing libraries/helpers (`LibAsset`, `LibSwap`, `LibAllowList`, `Validatable`, `SwapperV2`) over reimplementing behavior. (.cursor/rules/002-architecture.mdc [CONV:ARCH-SEPARATION]) (.cursor/rules/101-solidity-contracts.mdc) (.cursor/rules/100-solidity-basics.mdc)
- Refund/receiver-style addresses **should** be passed as explicit parameters instead of relying on `msg.sender`. (.cursor/rules/101-solidity-contracts.mdc)

### Facets (`src/Facets/**`)

- Facets **must** implement `_startBridge`, `swapAndStartBridgeTokensVia{FacetName}`, `startBridgeTokensVia{FacetName}`. (.cursor/rules/102-facets.mdc [CONV:FACET-REQS])
- Facet entrypoints **must** use the required modifiers (`nonReentrant`, `refundExcessNative`, `validateBridgeData`, and swap/destination-call guards). (.cursor/rules/102-facets.mdc [CONV:FACET-REQS])
- EVM receiver validation **must** ensure `{facetName}Data.receiverAddress` matches `bridgeData.receiver`, and chain IDs are consistent where applicable. (.cursor/rules/102-facets.mdc [CONV:FACET-REQS])
- If a bridge has a `minAmountOut`-style param, `swapAndStartBridgeTokensVia{FacetName}` **must** update it to account for positive slippage (proportional adjustment after `_depositAndSwap`). (.cursor/rules/102-facets.mdc)
- Non-EVM bridging **must** use `bridgeData.receiver == NON_EVM_ADDRESS` and a non-zero `bytes` receiver; validate non-EVM receiver fields are non-zero (revert `InvalidNonEVMReceiver()` if zero). (.cursor/rules/102-facets.mdc)

### Interfaces (`src/Interfaces/**`)

- Production interfaces **must** live in `src/Interfaces/` and **must not** mix interface + implementation. (.cursor/rules/103-solidity-interfaces.mdc)
- Interfaces **must** be `I*` prefixed and **should** include only the surface actually used by our code. (.cursor/rules/103-solidity-interfaces.mdc)
- If copied/shadowed from upstream, you **must** add a short NatSpec upstream reference note. (.cursor/rules/103-solidity-interfaces.mdc)

### Receiver contracts (`src/Periphery/Receiver*.sol`)

- External entrypoints **must** be authorized to the bridge protocol (revert `UnAuthorized()`), and constructor config **must** validate non-zero addresses (revert `InvalidConfig()`). (.cursor/rules/104-receiver-contracts.mdc)
- `_swapAndCompleteBridgeTokens` **must** use try/catch and on failure transfer raw bridged tokens to `receiver` and emit `LiFiTransferRecovered`. (.cursor/rules/104-receiver-contracts.mdc)
- Receiver contracts **must not** emit `LiFiTransferStarted` or `LiFiTransferCompleted`. (.cursor/rules/104-receiver-contracts.mdc)
- Receiver contracts **must** implement `receive() external payable {}` for native transfers. (.cursor/rules/104-receiver-contracts.mdc)

### Gas

- You **should not** trade safety/readability for minor gas wins; justify non-obvious optimizations and avoid assembly unless necessary and well-documented. (.cursor/rules/106-gas.mdc) (.cursor/rules/100-solidity-basics.mdc)

## 7) Scripts Guidelines

### Foundry deploy/update scripts (`script/**/*.s.sol`)

- Deploy/update scripts **must** follow `DeployScriptBase` / `UpdateScriptBase` patterns and load JSON config via `stdJson`. (.cursor/rules/107-solidity-scripts.mdc)
- Update scripts **should** call `update("{ContractName}")` and override `getExcludes()` to omit selectors that must not be included in the diamond cut. (.cursor/rules/107-solidity-scripts.mdc)
- If you edit a script under `script/deploy/`, you **must** check for a corresponding `script/deploy/zksync/` script and mirror changes (review and discard if not applicable). (.cursor/rules/107-solidity-scripts.mdc)

### TypeScript scripts (`script/**/*.ts`, `tasks/**/*.ts`)

- Contract interactions **must** use viem; ethers.js helpers are deprecated and **must not** be used. (.cursor/rules/200-typescript.mdc)
- Deprecated ethers-based helpers **must not** be used (e.g., `getProvider`, `getWalletFromPrivateKeyInDotEnv`, ethers `sendTransaction`, `ensureBalanceAndAllowanceToDiamond`). (.cursor/rules/200-typescript.mdc)
- Fatal script failures **should** use try/catch + `consola.error()` and exit non-zero (e.g., `process.exit(1)`). (.cursor/rules/200-typescript.mdc)
- New TS helpers **must** be covered by colocated `*.test.ts` using Bun with **100% coverage** (include edge/error paths). (.cursor/rules/200-typescript.mdc) (.cursor/rules/402-typescript-tests.mdc)
- Prefer helper reuse vs new code: (a) reuse `script/utils/` + `script/demoScripts/utils/` helpers for consistency, (b) write bespoke code only when no helper exists (faster now, higher drift risk). Repo preference: **reuse first**. (.cursor/rules/200-typescript.mdc) (.cursor/rules/000-global-standards.mdc)

### Bash scripts (`**/*.sh`)

- Bash scripts **must** validate env early, use uppercase variables, and use the repo’s logging/helper patterns. (.cursor/rules/300-bash.mdc)
- Bash scripts **should** start with `#!/bin/bash` and include usage/help text with clear exit codes. (.cursor/rules/300-bash.mdc)

## 8) Testing Rules

### Solidity (Foundry)

- Tests **must** live under `test/solidity/` mirroring `src/`, have `setUp()`, and use `initTestBase()` when inheriting `TestBase`. (.cursor/rules/400-solidity-tests.mdc)
- Facet tests **should** inherit `TestBaseFacet` (not `TestBase`) when standard facet functions need overriding. (.cursor/rules/400-solidity-tests.mdc)
- Test names **must** use `test_` / `testRevert_` / `testBase_`. (.cursor/rules/400-solidity-tests.mdc)
- Reverts **must** assert specific reasons (use `vm.expectRevert` specifically), and events **should** be checked with `vm.expectEmit(true,true,true,true,addr)`. (.cursor/rules/400-solidity-tests.mdc)

### TypeScript (Bun)

- TS tests **must** use Bun (`describe` / `it` / `expect`) and cover edge/error paths. (.cursor/rules/402-typescript-tests.mdc)

### Cross-language reporting

- After modifications, you **must** state which Foundry/Bun commands were run (or not run). (.cursor/rules/401-testing-patterns.mdc) (.cursor/rules/099-finish.mdc)

## 9) Commands (Cursor)

| Command         | Usage                             | When to use                                                                                                                               | Key pitfalls / constraints                                                                                                                                                              |
| --------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/add-new-rule` | `/add-new-rule`                   | Add/update `.cursor/rules/*.mdc` or `.cursor/commands/*.mdc` with correct scoping and no duplication. (.cursor/commands/add-new-rule.mdc) | You **must** use globs-first activation and avoid duplicate guidance across files. (.cursor/commands/add-new-rule.mdc)                                                                  |
| `/add-audit`    | `/add-audit` then paste PDF       | Add audit report + update `audit/auditLog.json`. (.cursor/commands/add-audit.mdc)                                                         | You **must not** update the audit log if any required field is missing/uncertain without explicit user confirmation. (.cursor/commands/add-audit.mdc)                                   |
| `/analyze-tx`   | `/analyze-tx <network> <tx_hash>` | Debug a specific transaction by network+hash. (.cursor/commands/analyze-tx.mdc)                                                           | You **must** only enter tx-analysis mode when the activation gate matches (hash+network+analysis request); otherwise ask for missing info. (.cursor/rules/600-transaction-analysis.mdc) |

## 10) Web-research insights applied

- Treat this file as a “README for agents” with explicit scope and expectations. ([agents.md](https://agents.md/))
- Prefer explicit **dos/don’ts** and concrete checklists to reduce ambiguity and drift. ([AGENTS.md best practices](https://agentsmd.io/agents-md-best-practices))
- Prefer **change-scoped validation** (targeted lint/tests) over always running full suites; run broader suites when necessary (more confidence, slower feedback). ([AGENTS.md best practices](https://agentsmd.io/agents-md-best-practices)) ([OpenAI Codex AGENTS.md](https://raw.githubusercontent.com/openai/codex/main/AGENTS.md))
- Document **safety/permission boundaries** (what actions require confirmation) to avoid surprising destructive changes. ([AGENTS.md best practices](https://agentsmd.io/agents-md-best-practices))
- “Repo rules override web guidance” (this file follows `.cursor/rules/*.mdc` and `.cursor/commands/*.mdc` as the source of truth). (.cursor/rules/000-global-standards.mdc) (.cursor/rules/README.md)

## 11) Final Self-Audit Checklist

- [ ] I cited sources for every “must/should/never/prefer” statement. (.cursor/rules/000-global-standards.mdc)
- [ ] I followed SPDX/pragma, naming, and NatSpec requirements for Solidity changes. (.cursor/rules/100-solidity-basics.mdc)
- [ ] I did not weaken governance/access controls or introduce unsafe new external-call patterns. (.cursor/rules/002-architecture.mdc) (.cursor/rules/105-security.mdc)
- [ ] I reused existing libs/helpers before adding new ones. (.cursor/rules/002-architecture.mdc) (.cursor/rules/200-typescript.mdc)
- [ ] I ran the relevant tests (or stated what I didn’t run). (.cursor/rules/099-finish.mdc) (.cursor/rules/401-testing-patterns.mdc)
- [ ] If context was nearing limit, I produced a handoff summary per policy. (.cursor/rules/003-context-monitor.mdc)
