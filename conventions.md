# Repository Overview

- **Project name:** LI.FI
- **Purpose:** LI.FI is a cross-chain bridge aggregation protocol that ensures secure and efficient interoperability through robust smart contracts and automated processes.
- **Core components:**
  - **Smart contracts:** Primarily built using the Diamond Standard (EIP-2535) with modular facets for core functionality, along with supporting periphery contracts for extended features and integrations.
  - **Deployment Framework:** Shell/bash scripts that provide a robust deployment framework with automated retry mechanisms for handling RPC issues and other deployment challenges. These scripts wrap Foundry's deployment functionality to add reliability and automation.
  - **Automation scripts:** Deployment, updating, and operational tasks.
  - **Tests:** Tests ensuring contract reliability and safety.
  - **Documentation:** Detailed guides, API specifications, and deployment instructions.

# Architectural Principles

## Diamond Standard (EIP-2535)

The Diamond Standard is the core architectural pattern used in this project. It provides:

- Modular contract architecture through facets
- Upgradeable contracts without proxy storage collision issues
- Ability to add, replace, and remove functionality
- Efficient contract size management
- Clear separation of concerns

## Development Framework

We use Foundry as our primary development and testing framework. Foundry provides:

- Fast and efficient testing
- Built-in fuzzing capabilities
- Gas optimization tools
- Deployment scripts
- Contract verification

## Security and Governance

- Production contracts are owned by Safe multisig contracts
- Changes require multiple signatures
- Moving towards Timelock-based governance:
  1. Propose change to multisig
  2. Collect required signatures
  3. Execute call to Timelock
  4. After minDelay period, anyone can execute the change

# Codebase Structure

    /lifi
     ├── .github/           # Github workflows
     ├── audit/             # Audit reports and log
     ├── config/            # Configuration files
     │   └── networks.json  # Key file containing information about supported networks
     ├── deployments/       # Deployment logs and addresses
     ├── docs/              # Project documentation, API specs, and guides
     ├── script/           # Deployment, updating, and automation scripts
     │   ├── deploy/       # Solidity deploy and update scripts
     │   │   └── zksync/   # ZKSync-specific deployment scripts
     │   ├── demoScripts/  # TypeScript demo scripts using viem
     │   ├── mongoDb/      # MongoDB integration for multisig proposals and RPC URLs
     │   ├── resources/    # Resource files like deployRequirements.json
     │   ├── tasks/        # Utility tasks and scripts
     │   └── utils/        # Helper utilities
     ├── src/              # All Solidity smart contracts
     │   ├── Facets/       # Diamond facets
     │   ├── Periphery/    # Standalone contracts called by the diamond
     │   ├── Helpers/      # Contracts meant to be inherited
     │   ├── Security/     # Security-related contracts (e.g., Timelock)
     │   └── Errors/       # Central collection of custom errors
     ├── test/             # Test files
     │   └── solidity/     # Solidity tests (using Foundry)
     └── README.md         # High-level project overview

## Directory Details

### Source Code (`src/`)

- **Facets/**: Contains all Diamond facets that are added to the Diamond contract
- **Periphery/**: Contains standalone contracts that are called by the Diamond but not added as facets
- **Helpers/**: Contains contracts meant to be inherited by other contracts
- **Security/**: Contains security-related contracts like Timelock for multisig proposals
- **Errors/**: Central collection of custom errors used across contracts

### Scripts (`script/`)

- **deploy/**: Contains Solidity deployment and update scripts
  - Includes ZKSync-specific deployment scripts
  - Update scripts for adding facets to the Diamond
- **demoScripts/**: TypeScript files demonstrating contract usage
  - Uses viem and helper functions
  - Shows how to prepare arguments and calculate parameters
  - Helps backend team understand contract usage
  - Provides end-to-end testing capabilities
- **mongoDb/**: MongoDB integration for:
  - Storing multisig proposals (alternative to Safe Transaction Service)
  - Sharing RPC URLs across developers
  - Future storage for deploy logs, API keys, and timelock proposals
- **resources/**: Contains configuration files like `deployRequirements.json`
- **tasks/**: Utility tasks and scripts
- **utils/**: Helper utilities

### Tests (`test/`)

- **solidity/**: Contains all Solidity tests using Foundry
  - Tests are organized mirroring the `src/` structure
  - Each contract should have its own test file
  - Currently only using Solidity tests (no TypeScript tests)

# Smart Contract Conventions

## Solidity Standards

- **Version Management:**

  - All Solidity files must start with: `pragma solidity {version}`
  - Version is defined in `foundry.toml`
  - Always refer to `foundry.toml` for current version

- **Design Patterns:**
  - Use established patterns (e.g., Ownable for access control, EIP-2535 Diamond Standard)
  - Favor modular design for reusability and security
  - Follow security best practices:
    - Validate constructor inputs rigorously
    - Use reentrancy guards
    - Optimize for gas efficiency

## Code Style

### Blank Line Rules

- **Between Sections:**

  - Single blank line between logical sections (state variables, events, constructor, functions)
  - Single blank line between function declarations
  - No blank lines between function signature and body

- **Inside Functions:**

  - Single blank line before new logical blocks (loops, conditions, function calls)
  - Single blank line after setting up state variables
  - Single blank line before emitting events
  - No blank lines between `if` statements and their `revert()` calls
  - No blank lines before `return` statements unless separate logical block

- **Between Declarations:**

  - Single blank line between structs and enums
  - Single blank line between mappings and other declarations
  - No blank line between related consecutive mappings
  - Single blank line between modifiers
  - No blank line between events and errors

- **In Tests:**
  - Blank line between `vm.expectRevert()` and function call
  - Blank line before `vm.stopPrank()` if separate logical block
  - Blank line before assertions
  - Single blank line between test cases

## Facet Contract Requirements

### Location and Naming

- Must reside in `src/Facets/`
- Names must include "Facet"

### Required Functions

1. `_startBridge` (internal)
2. `swapAndStartBridgeTokensVia{FacetName}`
3. `startBridgeTokensVia{FacetName}`

### Inheritance Structure

- **Interfaces:**
  - `ILiFi` - Standard interface for bridging operations
- **Libraries:**
  - `LibAsset` - Asset handling
  - `LibSwap` - Swap utilities
  - `LibAllowList` - Contract call approval
- **Security:**
  - `ReentrancyGuard` - Reentrancy protection
  - `SwapperV2` - Swap functionality
  - `Validatable` - Bridge data validation
- **External:**
  - `ECDSA` - Signature verification

### Parameter Handling

- **Sender/Refund Address:**

  - Avoid using `msg.sender` for refunds
  - Use dedicated parameters for refund addresses
  - Pass sender/depositor as parameter for direct refunds

- **Parameter Ordering:**
  - `receiverAddress` should be first in `{facetName}Data` struct
  - Must validate against `bridgeData.receiver`
  - Verify `targetChainId` against `bridgeData.destinationChain` for EVM-to-EVM

### Required Modifiers

- `nonReentrant` - Prevents reentrancy
- `refundExcessNative` - Handles excess native tokens
- `validateBridgeData` - Validates bridge parameters
- `doesNotContainSourceSwaps` / `doesContainSourceSwaps`
- `doesNotContainDestinationCalls` / `doesContainDestinationCalls`

### Events

1. **Transaction Start:**

   - Event: `LiFiTransferStarted`
   - Emit: At transaction start, before external calls
   - Purpose: Track bridge transactions

2. **Transaction Completion:**

   - Event: `LiFiTransferCompleted`
   - Emit: After successful execution
   - Purpose: Signal transaction finalization

3. **Transaction Recovery:**
   - Event: `LiFiTransferRecovered`
   - Emit: When transaction is recovered
   - Purpose: Track recovery attempts

# Development Workflow and Audit Process

## Development Process

1. **Repository Access**

   - All development must be done on branches within the main repository
   - PRs from forked repositories are not accepted due to GitHub Actions workflow limitations
   - Contributors must have write access to the main repository to create branches

2. **Branch Management**

   - Create feature branches from `main`
   - Use descriptive branch names (e.g., `feature/add-new-bridge`, `fix/hop-integration`)
   - Keep branches up to date with `main` through regular rebasing

3. Implementation

   - Use `bun codegen` for new facets
   - Write unit/fork tests with 100% line coverage
   - Create demo scripts for new functionality
   - Create feature PR on Github
   - Fix issues from code reviews

4. Review Process
   - Peer review within SC team
   - Bridge/protocol team review
     - Verify refund cases
     - Check parameter updates after source chain swaps
   - Deploy to staging diamond on 2-3 selected chains
   - Backend (BE) team integration
     - Label PR with `WaitForBackend`
     - BE writes unit tests
     - BE runs test transactions
   - QA team conducts integration tests
   - Frontend team review for new features

## Audit Process

1. Initial Development

   - Pass latest commit hash to auditor (AU)
   - Add to Audit Pipeline
   - AU conducts audit and creates dedicated repo with issues

2. Issue Resolution

   - SC team responds to each issue with either:
     - Acknowledgement & explanation (no code change)
     - Fix with commit hash
       - Include issue number in commit message
       - Unit test fixes in same or final commit

3. Audit Completion

   - AU reviews all fixes and acknowledgements
   - Creates final audit report including:
     - List of contracts in scope
     - Audit commit hash
     - Auditor details
     - Date of audit
     - List of issues with:
       - Description
       - Severity rating
       - Course of action
       - Fix commit hash
       - Auditor verification

4. Post-Audit
   - Upload audit report to PR
   - Update `auditLog.json`
   - Inform BE team of changes
   - BE team implements necessary changes
   - QA team conducts additional testing if needed

## Production Deployment

1. Pre-Deployment

   - Get PR approval from SC core dev
   - Get PR approval from auditor
   - Merge feature PR to `main`

2. Deployment Process
   - Create new PR based on `main`
   - Deploy contracts to production
   - Whitelist periphery contracts
   - Propose diamondCuts to multisig SAFEs
   - Review and sign/execute proposals
   - Update diamond logs
   - Peer review
   - Merge to `main`

## Ground Rules

1. Audit Logging & Reports

   - Audit log (JSON) in `audit/` folder
   - Audit reports (PDF) in `audit/reports/`
   - Only auditors can modify `audit/` folder

2. Branch & Deployment Rules

   - `main` branch is always "safe" and "fully audited"
   - Production deployment requires:
     - Code in `main` branch, or
     - Open PR with `AuditCompleted` label
   - `AuditCompleted` label managed by GitHub Actions only

3. Versioning & Testing

   - 100% unit test coverage required
   - Version tag format: `/// @custom:version 1.0.0`
   - Version bump required for any contract change

4. PR Review & Merging

   - Review required from `smart-contract-core` team
   - Only PRs from `contracts` repo allowed
   - `AuditNotRequired` label for non-contract changes

5. Security & Compliance
   - Security-critical changes require CTO approval
   - Pre-commit checker for sensitive data

## Process Review

- Annual review required
- Next review: August 2025
- Review criteria:
  - Security
  - Requirements compliance
  - Case coverage
