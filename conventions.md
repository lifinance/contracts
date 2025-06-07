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

  - All Solidity files must start with license identifier, followed by a blank line, then pragma statement
  - The EVM and Solidity version used for deployments (unless networks require lower versions) is defined in `foundry.toml`

- **Design Patterns:**
  - Use established patterns (e.g., Ownable for access control, EIP-2535 Diamond Standard)
  - Favor modular design for reusability and security
  - Follow security best practices:
    - Validate constructor inputs rigorously
    - Use reentrancy guards
    - Optimize for gas efficiency

## Code Style and Documentation

### General Rules

1. **Extensive Documentation**

   - All code should be thoroughly documented
   - Comments should explain the "why" not just the "what"
   - Complex logic must be documented with clear explanations
   - usage of Assembly must be justified and Assembly blocks must be extensively commented

2. **Blank Line Rules**

   - **Between Sections:**

     - Single blank line between logical sections (state variables, events, constructor, functions)
     - Single blank line between function declarations
     - No blank lines between function signature and body

   - **Inside Functions:**

     - Single blank line before new logical blocks (loops, conditions, function calls)
     - Single blank line after setting up state variables
     - Single blank line before emitting events
     - No blank lines between `if` statements and their `revert()` calls
     - Single blank line before `return` statements

   - **Between Declarations:**

     - Single blank line between structs and enums
     - Single blank line between mappings and other declarations
     - No blank line between related consecutive mappings
     - Single blank line between modifiers
     - No blank line between events and errors

   - **Test Files (.t.sol):**
     - Blank line between `vm.expectRevert()` and function call
     - Blank line before `vm.stopPrank()` if separate logical block
     - Blank line before assertions
     - Single blank line between test cases
     - Single blank line after `vm.startPrank(address)`
     - For `vm.expectEmit` blocks: no blank line between `vm.expectEmit` and its event definition, but blank lines before and after the entire block
     - Group related test assertions together without blank lines between them

### Documentation Requirements

1. **Contract Documentation**

   - Every contract must have a header comment containing:
     - Title of the contract
     - Author information
     - Notice describing the contract's purpose
     - Version number

2. **Function Documentation**

   - Every public/external function must have NatSpec comments
   - Include description of what the function does
   - Document parameters and return values
   - Note if function is restricted to admin or specific addresses

3. **Complex Logic Documentation**
   - Add inline comments for complex algorithms
   - Explain non-obvious optimizations
   - Document gas-saving techniques
   - Clarify mathematical operations

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
  - `ECDSA` - Signature verification (optional)

### Parameter Handling

- **Sender/Refund Address:**

  - Avoid using `msg.sender` for as refundAddress, use a dedicated parameter instead

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

## Solidity Test Conventions (.t.sol files)

### File Naming and Structure

- Test files must have a `.t.sol` extension
- Group and order imports with system libraries first and project files next

### Test Function Naming

- All tests that verify a successful execution must be prefixed with: `test_`
- All tests that verify a failure case must be prefixed with: `testRevert_`
- All negative tests must check for a specific revert reason
- For base or inherited tests, prefix with `testBase_`

### Test Structure and Setup

- Every test contract must include a `setUp()` function
- The `setUp()` function must:
  - Configure custom block numbers
  - Initialize base contracts
  - Set up facets
  - Assign labels using `vm.label`
- Any contract inheriting from `TestBase.sol` must call `initTestBase()` in `setUp()`
- Use `vm.startPrank(address)` and `vm.stopPrank()` for user simulation

### Assertions and Event Testing

- Use `assertEq()` for checking equality of values
- Use custom assertion modifiers for balance changes
- Use `vm.expectEmit(true, true, true, true, <contractAddress>)` for event testing
- Verify expected events are emitted with correct parameters

### Test Best Practices

- Include comments to explain test purpose
- Maintain consistent order in function calls and assertions
- Structure tests: setup → execute → assert

## Solidity Linter (solhint) Configuration

### Gas and Error Rules

- `gas-custom-errors`: Enforce custom errors for gas efficiency

### Security Rules

- `avoid-sha3`: Use `keccak256` instead of `sha3`
- `avoid-suicide`: Disallow `selfdestruct`
- `avoid-throw`: Use `revert` or `require`
- `avoid-tx-origin`: Prohibit `tx.origin` for authorization
- `check-send-result`: Check `send` return values
- `compiler-version`: Match `^0.8.17`
- `func-visibility`: Enforce explicit visibility
- `multiple-sends`: Discourage multiple `send` calls
- `no-complex-fallback`: Prevent complex fallback logic
- `no-inline-assembly`: Avoid inline assembly
- `not-rely-on-block-hash`: No `blockhash` for security
- `not-rely-on-time`: Avoid block timestamps
- `reentrancy`: Enforce reentrancy protection
- `state-visibility`: Require explicit state visibility

### Naming and Ordering Rules

- `use-forbidden-name`: Disallow reserved names
- `var-name-mixedcase`: Enforce mixedCase variables
- `imports-on-top`: Imports at file top
- `visibility-modifier-order`: Proper modifier order
- `immutable-vars-naming`: UPPERCASE for immutables
- `func-name-mixedcase`: mixedCase functions
- `event-name-capwords`: CapWords events
- `contract-name-capwords`: CapWords contracts
- `const-name-snakecase`: snake_case constants
- `interface-starts-with-i`: "I" prefix for interfaces
- `quotes`: Double quotes for strings

# Github Workflows Conventions

## Sensitive Data Handling

- Use Github Secrets for sensitive data
- Reference secrets using `${{ secrets.SECRET_NAME }}`

## File Structure

- Begin with clear description (YAML comments)
- Include descriptive comments throughout
- Define triggers explicitly
- Use conditional checks with `if:`
- Name jobs and steps clearly
- Include notification steps
- Set explicit permissions with comments

# Bash Scripts

## General Structure

- Begin with `#!/bin/bash`
- Organize into modular functions
- Extract common logic to helper files
- Load environment from `.env` or `config.sh`
- Declare global variables in config files
- Update `.env.example` accordingly

## Error Handling and Logging

- Use helper functions for logging
- Validate inputs and environment early
- Check function exit status with `checkFailure`
- Add system packages to `preinstall.sh`

## User Interaction

- Use clear prompts with instructions
- Document TODOs and limitations
- Use consistent indentation and naming
- Provide usage instructions
- Separate core operations into functions

# Audit Logs and Reports

## Audit Log Structure (`auditLog.json`)

- **audits:** Entries with unique ID (`auditYYYYMMDD_X`)

  - `auditCompletedOn`: Date (DD.MM.YYYY or YYYY-MM-DD)
  - `auditedBy`: Name/firm
  - `auditorGitHandle`: (if applicable)
  - `auditReportPath`: PDF location
  - `auditCommitHash`: Audited commit

- **auditedContracts:** Maps contracts to audit IDs

## Report Storage

- Store PDFs in `audit/reports/`
- Individual contract format: `YYYY.MM.DD_ContractName(version).pdf`
- Multiple contracts format: `YYYY.MM.DD_CustomFileName.pdf`

# Deployment and Update Scripts

## Location and Naming

- Located in `script/deploy/facets/`
- Deployment scripts: `Deploy{ContractName}.s.sol`
- Update scripts: `Update{ContractName}.s.sol`

## Script Structure

### Deployment Scripts

- Inherit `DeployScriptBase`
- Use JSON config with `stdJson`
- Define `getConstructorArgs()` if needed
- Encode constructor arguments
- Call `deploy()` with `type({ContractName}).creationCode`

### Update Scripts

- Inherit `UpdateScriptBase`
- Call `update("{ContractName}")`
- Use `getExcludes()` for special cases
- Return array of excluded function selectors

## Configuration

- Reference JSON configs in `/config/`
- Use dynamic path selection:
  ```solidity
  string memory path = string.concat(root, "/config/{facetName}.json");
  address configValue = _getConfigContractAddress(
    path,
    string.concat(".{key}.", network, ".{subkey}")
  );
  ```

# Template-based Code Generation

## Overview

- Use `plop facet` to generate new facets
- Templates stored in `templates/` folder

## Template Files

- **Facet:** `facet.template.hbs` (.sol)
- **Config:** `facetConfig.template.hbs` (.json)
- **Deploy:** `facetDeployScript.template.hbs` (.s.sol)
- **Update:** `facetUpdateScript.template.hbs` (.s.sol)
- **Test:** `facetTest.template.hbs` (.t.sol)
- **Demo:** `facetDemoScript.template.hbs` (.ts)
- **Doc:** `facetDoc.template.hbs` (.md)

# Configuration Files

## `deployRequirements.json`

- Location: `script/deploy/resources/deployRequirements.json`
- Purpose: Dictates deployment rules and dependencies
- Specifies:
  - Zero address restrictions
  - Required external config files
  - Network-specific parameters
- Used in `helperFunctions.sh` for deployment validation

## `targetState.json`

- Location: `script/deploy/`
- Purpose: Defines expected contract versions per network
- Structure:
  - Network keys (e.g., `mainnet`, `arbitrum`)
  - Environment keys (e.g., `production`, `staging`)
  - Contract versions for facets, periphery, and core contracts
- Used to ensure version consistency across deployments
