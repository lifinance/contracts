---
name: Codebase structure
description: Directory structure, file organization, and where to place new files
globs:
  - '**/*'
alwaysApply: true
---

## Directory Structure

```
/contracts
 ├── .cursor/              # Cursor AI rules and prompts (do not modify unless adding rules)
 ├── .github/              # GitHub workflows and CI/CD
 ├── audit/                # Audit reports and audit log
 │   └── reports/          # PDF audit reports
 ├── broadcast/            # Foundry broadcast artifacts (generated, gitignored)
 ├── cache/                # Foundry cache (generated, gitignored)
 ├── config/               # Configuration files for deployments and integrations
 │   └── networks.json     # Key file: network definitions and chain IDs
 ├── deployments/          # Deployment logs and contract addresses (JSON)
 ├── dist/                 # Distribution files (generated)
 ├── docs/                 # Project documentation, API specs, and guides
 ├── lib/                  # External dependencies (git submodules)
 │   ├── openzeppelin-contracts/
 │   ├── solmate/
 │   ├── solady/
 │   ├── Permit2/
 │   └── ...                # Other dependencies
 ├── out/                  # Foundry compilation output (generated, gitignored)
 │                          # Contains ABIs and methodIdentifiers for all contracts
 │                          # Useful for calldata analysis, function selector identification, and prompts
 ├── safe/                 # Safe contract artifacts (flattened contracts)
 ├── script/               # Deployment, updating, and automation scripts
 │   ├── deploy/           # Solidity deployment and update scripts
 │   │   ├── facets/       # Facet deployment scripts
 │   │   ├── safe/         # Safe multisig integration
 │   │   ├── shared/       # Shared deployment utilities
 │   │   ├── tron/         # Tron-specific scripts
 │   │   └── zksync/       # ZKSync-specific deployment scripts
 │   ├── demoScripts/      # TypeScript demo scripts
 │   │   └── utils/        # Demo script helpers
 │   ├── mongoDb/          # MongoDB integration for multisig proposals and RPC URLs
 │   ├── resources/        # Resource files (e.g., deployRequirements.json, gasRebates.json)
 │   ├── tasks/            # Utility tasks and scripts
 │   │   └── solidity/     # Solidity task scripts
 │   ├── troncast/         # Tron-specific CLI utilities
 │   └── utils/            # Helper utilities for scripts
 ├── src/                  # All Solidity smart contracts (source code)
 │   ├── Facets/           # Diamond facets (EIP-2535) - entrypoints to Diamond
 │   ├── Periphery/        # Standalone contracts called by Diamond (not facets)
 │   ├── Helpers/          # Inheritable utility contracts
 │   ├── Interfaces/       # External contract interfaces and IERC* standards
 │   ├── Libraries/        # Internal libraries (LibAsset, LibSwap, LibDiamond, etc.)
 │   ├── Security/         # Security-related contracts (e.g., Timelock)
 │   ├── Errors/           # Central collection of custom errors
 │   └── LiFiDiamond.sol   # Main Diamond contract
 ├── tasks/                # Root-level utility tasks (e.g., generateDiamondABI.ts)
 ├── templates/            # Plop templates for code generation
 ├── test/                 # Test files
 │   └── solidity/        # Solidity tests (Foundry) - mirrors src/ structure
 ├── typechain/            # TypeScript type generation (generated, gitignored)
 ├── foundry.toml          # Foundry configuration
 ├── remappings.txt        # Solidity import remappings
 └── README.md             # Project overview
```

## Source Code Organization (`src/`)

- **Facets/**: Diamond facets implementing specific functionality. Each facet is added to the Diamond via `diamondCut`. Keep facets thin; delegate complex logic to libraries.
- **Periphery/**: Standalone contracts that the Diamond calls but are not facets (e.g., Executor, ERC20Proxy, Permit2Proxy). These can be upgraded independently.
- **Helpers/**: Contracts meant to be inherited (e.g., Validatable, SwapperV2, ReentrancyGuard). Not deployed directly.
- **Interfaces/**: External contract interfaces and IERC\* standards. Use for type safety when interacting with external contracts.
- **Libraries/**: Internal libraries containing reusable logic (LibAsset, LibSwap, LibDiamond, LibAllowList, etc.). Libraries are stateless and provide pure/view/internal functions.
- **Security/**: Security-related contracts like TimelockController for governance.
- **Errors/**: Central collection of custom errors. Use `GenericErrors.sol` for common errors; facet-specific errors can be defined locally.

## Script Organization (`script/`)

- **deploy/**: Solidity deployment scripts (`.s.sol`). Use Foundry's `Script` contract pattern. Place facet deployments in `deploy/facets/`.
- **demoScripts/**: TypeScript examples demonstrating contract usage. Reference existing demos for patterns.
- **tasks/**: Utility scripts for maintenance tasks (e.g., syncing whitelists, updating configs).
- **utils/**: Shared TypeScript utilities for scripts.

## Import Paths and Remappings

Use remappings defined in `remappings.txt`:

- `lifi/` → `src/` (e.g., `import lifi/Facets/SomeFacet.sol`)
- `test/` → `test/` (e.g., `import test/TestBase.sol`)
- External libs: `@openzeppelin/`, `solmate/`, `solady/`, `permit2/`, etc.

## File Placement Guidelines

- **New facets**: `src/Facets/` (use plop templates if available)
- **New periphery contracts**: `src/Periphery/`
- **New libraries**: `src/Libraries/`
- **New interfaces**: `src/Interfaces/`
- **New helpers**: `src/Helpers/`
- **New errors**: Add to `src/Errors/GenericErrors.sol` or define locally in facet if facet-specific
- **Deployment scripts**: `script/deploy/facets/` for facets, `script/deploy/` for other contracts
- **Demo scripts**: `script/demoScripts/`
- **Tests**: `test/solidity/` mirroring `src/` structure

## Generated vs Source Directories

**Generated (gitignored, do not commit)**:

- `broadcast/` - Foundry broadcast artifacts
- `cache/` - Foundry cache
- `out/` - Compilation output
- `typechain/` - TypeScript type generation
- `node_modules/` - NPM dependencies

**Source (committed)**:

- `src/`, `script/`, `test/`, `config/`, `deployments/`, `lib/`, `docs/`

## Best Practices

- **Use existing patterns**: Before creating new files, check if similar patterns exist
- **Follow naming**: Use existing naming conventions (see [CONV:NAMING])
- **Libraries over duplication**: Prefer using existing libraries (`LibAsset`, `LibSwap`, etc.) over reimplementing logic
- **Import organization**: Group imports: external libs → interfaces → libraries → contracts
- **Plop templates**: Use `plop` templates when available for generating new facets/contracts
