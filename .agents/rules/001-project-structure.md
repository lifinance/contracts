---
name: Codebase structure
description: Directory structure, file organization, and where to place new files
globs:
  - '**/*'
alwaysApply: true
---

## Non-obvious locations

- `config/networks.json`: network definitions and chain IDs.
- `out/` (gitignored Foundry output): ABIs and `methodIdentifiers` for every contract — use it for calldata analysis and selector identification.
- `safe/`: flattened Safe contract artifacts.
- `script/deploy/facets/`: deploy/update scripts for **every** contract, facets and periphery alike (zkSync variants in `script/deploy/zksync/`).
- `script/deploy/resources/`: `deployRequirements.json`, `immutableRegistry.json`, deploy reminders.
- `script/mongoDb/`: MongoDB integration for multisig proposals and RPC URLs.
- `script/resources/gasRebates.json`; `tasks/` (repo root): utility tasks such as `generateDiamondABI.ts`.
- `templates/`: `plop` templates — use them when generating new facets/contracts.

## Placement

- **Periphery** (`src/Periphery/`): standalone contracts the Diamond calls (e.g. Executor, ERC20Proxy, Permit2Proxy); upgradable independently of the Diamond.
- **Helpers** (`src/Helpers/`): inherited only (e.g. Validatable, SwapperV2, ReentrancyGuard), never deployed directly.
- **Errors**: common ones in `src/Errors/GenericErrors.sol`; facet-specific errors stay in the facet.
- **Interfaces**: `src/Interfaces/`. **Libraries**: `src/Libraries/` (stateless; pure/view/internal).
- **Tests**: `test/solidity/`, mirroring `src/`. **Demo scripts**: `script/demoScripts/`.
- Solidity import groups: external libs → interfaces → libraries → contracts.

## Import Paths and Remappings

Use remappings defined in `remappings.txt`:

- `lifi/` → `src/` (e.g., `import { SomeFacet } from "lifi/Facets/SomeFacet.sol"`): tests and scripts import this way; contracts in `src/` import each other by relative path
- `test/` → `test/` (e.g., `import test/TestBase.sol`)
- External libs: `@openzeppelin/`, `solmate/`, `solady/`, `permit2/`, etc.

## Deployment Logs (`deployments/`)

`deployments/<network>.json` and `deployments/<network>.diamond.json` describe **current**
on-chain state, not deployment history: a facet the Diamond loupe no longer routes is removed
from both in the PR that records the removal. Periphery is asymmetric: a current contract's
entry follows the `PeripheryRegistry` (no longer resolves → remove; resolves elsewhere →
correct), while a **deprecated** periphery contract (source deleted) is removed even though the
registry still resolves its name — nothing unregisters periphery at deprecation, so that
residue is not liveness. Each kind is checked against its own source of truth, never the
other's. Past deployments come from the MongoDB
deployment log and this repo's git history. When to prune, and when not to:
[docs/DeploymentLogs.md](../../docs/DeploymentLogs.md).
