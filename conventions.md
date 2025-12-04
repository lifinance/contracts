## LI.FI Smart Contract Conventions

This document is a **high-level architectural and process guide**.  
All **mechanical, enforceable rules** (style, NatSpec, testing, scripts, facets, etc.) live in:

- `.cursor/rules/*.mdc` (per-file-type guardrails), and
- `docs/conventions_digest/*` (short machine-oriented digests with `[CONV:*]` anchors).

When in doubt:

- **Humans** should read this file for the “why”.
- **Agents** should prefer `.cursor/rules` + `docs/conventions_digest/*` and only fall back to this file for architecture/rationale.

---

## 1. Repository Overview

- **Project**: LI.FI – cross-chain bridge aggregation protocol.
- **Goal**: Secure, observable cross-chain execution via a Diamond-based core, audited integrations, and strict governance.
- **Main pieces**:
  - **Smart contracts**: Diamond (EIP-2535) with facets, periphery contracts, helpers, and security components.
  - **Scripts**: Solidity deploy/update scripts plus TypeScript/Bash tooling for demos, operations, and CI.
  - **Tests**: Primarily Solidity (Foundry) with some TypeScript helper tests where appropriate.
  - **Docs**: This file + `docs/*` reference docs and `docs/conventions_digest/*` digests.

Conceptual layout:

- `src/Facets/` – Diamond entrypoints (thin, integration-specific logic).
- `src/Periphery/` – Standalone helper contracts called by the Diamond.
- `src/Helpers/` – Inheritable libraries and shared helpers.
- `src/Security/` – Governance/timelock and security-related contracts.
- `src/Errors/` – Central generic error collection.
- `script/` – Deploy/update scripts, demo scripts, utilities, tasks.
- `test/solidity/` – Foundry tests mirroring `src/`.

For exact, enforceable rules on structure and naming, see:

- `.cursor/rules/10-solidity-contracts.mdc`
- `.cursor/rules/11-facets.mdc`
- `.cursor/rules/12-solidity-tests.mdc`
- `.cursor/rules/13-solidity-interfaces.mdc`
- `docs/conventions_digest/solidity_style.md`

---

## 2. Architectural Principles

### 2.1 Diamond Standard (EIP-2535)

We use a **single Diamond** as the main entrypoint:

- **Facets** provide modular functionality grouped by concern (bridges, swaps, receivers, admin, etc.).
- **Libraries** (e.g., `LibAsset`, `LibSwap`, `LibAllowList`, `LibStorage`) centralize cross-cutting logic, storage, and validation.
- **Periphery contracts** handle specialized flows that don’t belong directly in the Diamond.

Design intent:

- Keep facets **thin** and focused; heavy lifting goes into libraries and helpers.
- Maintain a clear mapping from **external actions** (bridge, swap, recover, etc.) to specific facets and events.
- Treat selector layout and storage as **critical invariants** for upgrades.

Key enforcement rules live in:

- `.cursor/rules/15-architecture.mdc`
- `.cursor/rules/11-facets.mdc`
- `docs/conventions_digest/facets.md` (`[CONV:FACET-REQS]`, `[CONV:EVENTS]`, `[CONV:NON-EVM]`)

### 2.2 Development Framework

We use **Foundry** as the main development and testing framework:

- Fast compile/test/fuzz loops.
- Native Solidity deployment/update scripts.
- Good integration with JSON config, templates, and CI.

Deployment/update patterns are captured in:

- `.cursor/rules/20-solidity-scripts.mdc`
- `docs/conventions_digest/scripts_and_ci.md` (`[CONV:DEPLOY]`)
- `docs/Deploy.md` for procedural “how to deploy/update” flows.

### 2.3 Security and Governance

Core principles:

- **Safe multisigs** and/or **timelock controllers** own production contracts.
- **No shortcuts**: facets and periphery contracts should not introduce backdoors that bypass Safe/timelock flows.
- **Upgrades** must respect:
  - Selector layout and storage layout.
  - Timelock delay and quorum/approval rules.

Process (simplified):

1. Propose changes (facet updates, periphery deployments) and review them (internally + auditors where applicable).
2. Collect approvals via Safe (or similar) and schedule via timelock where configured.
3. Execute upgrades through the intended governance path only.

Enforced by:

- `.cursor/rules/15-architecture.mdc`
- `.cursor/rules/16-security.mdc`
- Security sections and audit docs under `docs/`.

---

## 3. Smart Contract Conventions (high level)

All **mechanical conventions** for Solidity live in:

- `docs/conventions_digest/solidity_style.md`  
  (`[CONV:LICENSE]`, `[CONV:NAMING]`, `[CONV:NATSPEC]`, `[CONV:BLANKLINES]`)
- `docs/conventions_digest/errors_and_tests.md`  
  (`[CONV:ERR-GENERIC]`, `[CONV:ERR-FACET]`, `[CONV:TESTS]`)
- `.cursor/rules/05-solidity-basics.mdc`
- `.cursor/rules/10-solidity-contracts.mdc`
- `.cursor/rules/12-solidity-tests.mdc`
- `.cursor/rules/13-solidity-interfaces.mdc`

Conceptually:

- **Licensing & versions**: All LI.FI-owned Solidity code follows a consistent SPDX and pragma policy ([CONV:LICENSE]).
- **Naming & style**: Interfaces, contracts, variables, and params follow consistent naming and layout rules ([CONV:NAMING], [CONV:BLANKLINES]).
- **Errors**:
  - Generic, reusable errors live in `src/Errors/GenericErrors.sol` ([CONV:ERR-GENERIC]).
  - Protocol/facet-specific errors live next to their facet ([CONV:ERR-FACET]).
- **Interfaces**: Reside in `src/Interfaces`, prefixed with `I*`, containing only what we actually use.

Rule of thumb:

- If you’re deciding **how** to format or structure something → see the digest + `.cursorrules`.
- If you’re deciding **why** we chose a particular pattern → this file and the longer docs under `docs/` are the place to look.

---

## 4. Facets and Events

Facet contracts are the **primary integration points** on the Diamond:

- One facet per major integration or protocol family.
- Shared behavior (asset handling, swaps, allowlists, validation) lives in libraries.
- Events must be emitted **consistently** so off-chain systems can reason about transfers and recoveries.

Key ideas:

- All facets are in `src/Facets/` and suffixed with `Facet`.
- Facets expose standard entrypoints and use shared modifiers to enforce validation and invariants.
- The **same core events** (`LiFiTransferStarted`, `LiFiTransferCompleted`, `LiFiTransferRecovered`, `GenericSwapCompleted`) are used across integrations with strict rules about where they may be emitted.
- Non-EVM flows follow a special pattern (e.g., `NON_EVM_ADDRESS` and `bytes` receivers).

The exact required functions, modifiers, parameter rules, and event usage are specified in:

- `.cursor/rules/11-facets.mdc`
- `docs/conventions_digest/facets.md` (`[CONV:FACET-REQS]`, `[CONV:EVENTS]`, `[CONV:NON-EVM]`)

---

## 5. Testing Philosophy

**Solidity tests (Foundry)**:

- Mirror the structure of `src/` so each contract has an obvious corresponding test.
- Follow consistent naming for success vs failure cases.
- Use explicit setup (`setUp()`, `initTestBase()`, labels, pranks) and structure tests as **setup → execute → assert**.
- Reuse shared base contracts for cross-cutting behavior (e.g., whitelists).

**TypeScript tests**:

- Focus on **helper functions** and script logic.
- Use Bun’s test runner (`describe` / `it` / `expect`) with colocated `{name}.test.ts` files.
- Aim for complete coverage of parameters, edge cases, and error paths.

For concrete rules and examples, see:

- `docs/conventions_digest/errors_and_tests.md` (`[CONV:TESTS]`)
- `.cursor/rules/12-solidity-tests.mdc`
- `.cursor/rules/18-testing.mdc`
- `.cursor/rules/30-typescript.mdc`

---

## 6. Scripts, Tooling, and CI

### 6.1 Solidity deploy/update scripts

Foundry scripts encapsulate **deploy and update** flows:

- **Deploy scripts** handle creation of new contracts/facets using a standard base (`DeployScriptBase`).
- **Update scripts** apply Diamond cuts and other upgrades via `UpdateScriptBase`.
- Config data (constructor args, addresses, etc.) is read from JSON files and central configs.

Authoritative patterns:

- `.cursor/rules/20-solidity-scripts.mdc`
- `docs/conventions_digest/scripts_and_ci.md` (`[CONV:DEPLOY]`)
- `docs/Deploy.md` (step-by-step deployment guidance).

### 6.2 TypeScript scripts

TypeScript scripts are used for:

- Demoing contract usage (e.g., bridge flows, swaps).
- Operational tooling (e.g., deployment helpers, migration checks).
- CI/maintenance tasks where TS is a better fit than Solidity or Bash.

Conventions (details in `[CONV:SCRIPTS-TS]` and `.cursor/rules/30-typescript.mdc`):

- Use **viem**, not ethers.js, for all contract interactions.
- Run with `bunx tsx`, follow `.eslintrc.cjs`, avoid `any`, and use TypeChain types (e.g., `ILiFi.BridgeDataStruct`).
- Reuse existing helpers for deployments, viem client setup, env handling, and swaps.
- New helpers require colocated tests with **100% coverage** using Bun’s test runner.

### 6.3 Bash deployment framework

Bash scripts wrap Foundry to provide:

- Robust retries around flaky RPCs.
- Centralized environment loading and validation.
- Consistent logging and error handling.

Detailed structure and rules:

- `.cursor/rules/40-bash.mdc`
- `docs/conventions_digest/scripts_and_ci.md` (`[CONV:BASH]`)
- `docs/Deploy.md` and other deployment docs in `docs/`.

### 6.4 Audits and GitHub Actions

We keep an explicit trail of audits and CI behavior:

- Audit metadata lives in `audit/auditLog.json`, with reports under `audit/reports/`.
- GitHub Actions workflows:
  - Use secrets for sensitive data.
  - Have clear triggers, step names, and explicit permissions.
  - Are documented with comments for maintainability and security review.

See:

- `docs/conventions_digest/scripts_and_ci.md` (`[CONV:AUDIT-DOCS]`, `[CONV:GHA]`)
- `audit/` and `.github/workflows/*` in the repo.

---

## 7. How to extend conventions safely

When you introduce new patterns (contracts, scripts, tests):

- **Add the enforceable bits** to `.cursor/rules/*.mdc` and/or `docs/conventions_digest/*` with new `[CONV:*]` anchors.
- Keep this file focused on:
  - Architectural shape (where things live, how they interact).
  - Governance/security guarantees.
  - High-level rationale and tradeoffs between options.

If a new pattern becomes common:

- Add a **short digest entry** (`docs/conventions_digest/*`) for agents.
- Update `.cursor/rules` to reference that digest instead of copying long explanations.


