# LI.FI Smart Contract Conventions

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

## Smart Contract Conventions

### Solidity Standards

- **Version Management:**

  - All Solidity files must start with license identifier, followed by a blank line, then pragma statement
  - The EVM and Solidity version used for deployments (unless networks require lower versions) is defined in `foundry.toml`

- **License requirements:**
  All our own Solidity files must use the LGPL-3.0 license identifier. This applies to:

  - All contracts in `src/` directory (except external dependencies)
  - All test files in `test/solidity/` directory
  - All deployment and task scripts in `script/` directory

  License identifier format:

  ```solidity
  // SPDX-License-Identifier: LGPL-3.0-only
  ```

  Exceptions:

  - External dependencies (libraries, etc.)
  - External contracts copied from other projects: here we must retain the original license and add information from where we copied this contract

  Example for how to mark a contract that

  ```solidity
  // SPDX-License-Identifier: MIT
  // Modified from: https://github.com/nomad-xyz/ExcessivelySafeCall
  // Original license: MIT OR Apache-2.0
  // Modifications © 2025 LI.FI
  pragma solidity ^0.8.17;
  ```

- **Design Patterns:**

  - Use established patterns (e.g., Ownable for access control, EIP-2535 Diamond Standard)
  - Favor modular design for reusability and security
  - Follow security best practices:
    - Validate constructor inputs rigorously
    - Use reentrancy guards
    - Optimize for gas efficiency

- **Error Handling:**

  - **Generic errors** must be defined in `src/Errors/GenericErrors.sol`
    - Use for common validation errors that apply across multiple contracts
    - When adding new generic errors, increment the version in `@custom:version` comment
    - Examples: `InvalidAmount()`, `InvalidCallData()`, `UnAuthorized()`
  - **Facet-specific errors** should be defined within the facet itself
    - Use for business logic errors specific to that protocol integration
    - Examples: `InvalidQuote()`, `BridgeNotSupported()`, `ProtocolSpecificError()`
  - Error names should be descriptive and follow PascalCase
  - Errors should not include error messages (gas optimization)
  - Use custom error types rather than generic `revert()` statements

- **Interface Design Standards:**

  - All interfaces must start with `I` prefix (e.g., `ILiFi`, `IStargate`)
  - Use consistent parameter naming across similar interfaces
  - All interfaces must be placed in separate files in the `src/Interfaces` directory
  - Do not define interfaces in the same file as their implementation

- **Variable Naming Conventions:**
  - **State variables**: Use camelCase (e.g., `userBalance`, `tokenAddress`)
  - **Function parameters**: Use camelCase with underscore prefix (e.g., `_amount`, `_recipient`)
  - **Constants**: Use CONSTANT_CASE with underscores (e.g., `MAX_FEE`, `DEFAULT_TIMEOUT`)
  - **Immutable variables**: Use CONSTANT_CASE with underscores (e.g., `RELAY_DEPOSITORY`, `CHAIN_ID`)
  - **Private/internal variables**: Use camelCase (e.g., `internalState`, `helperValue`)
  - **Function names**: Use camelCase (e.g., `startBridge`, `validateInput`)

## Code Style and Documentation

### General Rules

1. **Extensive Documentation**

   - All code should be thoroughly documented
   - Comments should explain the "why" not just the "what"
   - Complex logic must be documented with clear explanations
   - Usage of Assembly must be justified and Assembly blocks must be extensively commented

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

1. **Contract NatSpec Documentation**

   - Every contract MUST have the following NatSpec tags in this order:
     ```solidity
     /// @title ContractName
     /// @author LI.FI (https://li.fi)
     /// @notice Brief description of the contract's purpose
     /// @custom:version X.Y.Z
     ```
   - The @author tag MUST always be "LI.FI (https://li.fi)"
   - The @custom:version MUST follow semantic versioning (X.Y.Z format)
   - Additional NatSpec tags (like @dev, @custom:security, etc.) may be added after these required tags

2. **Interface NatSpec Documentation**

   - Every interface MUST have the following NatSpec tags in this order:
     ```solidity
     /// @title InterfaceName
     /// @notice Brief description of the interface
     /// @author LI.FI (https://li.fi)
     /// @custom:version X.Y.Z
     ```
   - The @custom:version MUST follow semantic versioning (X.Y.Z format)
   - For external interfaces that we're wrapping, original authorship should be preserved if applicable

3. **Function Documentation**

   - Every public/external function must have NatSpec comments
   - Include description of what the function does
   - Document parameters and return values
   - Note if function is restricted to admin or specific addresses
   - Example:
     ```solidity
     /// @notice Brief description of function purpose
     /// @param parameterName Description of parameter
     /// @return Description of return value
     /// @dev Additional details about implementation (optional)
     ```

4. **Complex Logic Documentation**
   - Add inline comments for complex algorithms
   - Explain non-obvious optimizations
   - Document gas-saving techniques
   - Clarify mathematical operations

### Facet Contract Requirements

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
   - Usage: ONLY to be used in Facet contracts

2. **Transaction Completion:**

   - Event: `LiFiTransferCompleted`
   - Emit: After successful execution
   - Purpose: Signal transaction finalization
   - Usage: ONLY to be used in the Executor contract, NOT in Facet contracts

3. **Transaction Recovery:**

   - Event: `LiFiTransferRecovered`
   - Emit: When transaction is recovered
   - Purpose: Track recovery attempts
   - Usage: ONLY to be used in Receiver contracts (e.g., ReceiverAcrossV3, ReceiverChainflip, ReceiverStargateV2), NOT in Facet contracts

4. **Same-chain Swap:**
   - Event: `GenericSwapCompleted`
   - Emit: After successful execution of same-chain swap
   - Purpose: Track completion of same-chain swap operations

### Fee Handling

- For native fees, use the `_depositAndSwap` variant
- Reserve required fee before execution

### Non-EVM Chain Support

- Use `bytes` (not `bytes32`) for `receiverAddress`
- Validate non-EVM address is not zero:
  ```solidity
  if ({facetName}Data.receiverAddress == bytes(0)) {
      revert InvalidNonEVMReceiver(
          {facetName}Data.receiverAddress,
          bytes(0)
      );
  }
  ```
- Use `NON_EVM_ADDRESS` (src/Helpers/LiFiData.sol) for `bridgeData.receiver`:
  ```solidity
  if (bridgeData.receiver != NON_EVM_ADDRESS) {
      revert InvalidCallData();
  }
  ```

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
- Use `vm.expectRevert()` to verify specific revert reasons in failure test cases. Simply checking the success/failure status of a call() is not sufficient.
- Use `vm.expectEmit(true, true, true, true, <contractAddress>)` for event testing
- Verify expected events are emitted with correct parameters

### Test Best Practices

- Include comments to explain test purpose
- Maintain consistent order in function calls and assertions
- Structure tests: setup → execute → assert

## Solidity Linter (solhint) Configuration

All Solidity files must follow the rules defined in `.solhint.json`. This configuration enforces our coding standards for gas optimization, security, and code style.

## Script Conventions

### TypeScript Scripts

- All scripts must follow the rules defined in `.eslintrc.cjs`
- Use async/await for asynchronous operations
- Handle errors appropriately with try/catch blocks
- Include proper logging for debugging and monitoring
- Use environment variables for configuration
- Include proper type definitions
- All scripts must use `citty` for CLI argument parsing
- Use `consola` for consistent logging across scripts
- Environment variables should be validated using `getEnvVar()` helper
- Scripts should exit with appropriate exit codes (0 for success, 1 for error)

- **Execution Environment:**
  - All scripts should use `bunx tsx` for TypeScript execution

### Bash Scripts

Bash scripts provide the robust deployment framework with automated retry mechanisms for handling RPC issues and other deployment challenges. These scripts wrap Foundry's deployment functionality to add reliability and automation.

#### General Structure

- **Shebang and Organization:**

  - Begin with `#!/bin/bash`
  - Organize into modular functions with clear sections:
    - "Logging"
    - "Error handling and logging"
    - "Deployment functions"
  - Follow DRY principle using helper files
  - Extract common logic to helper files
  - Separate core operations into functions

- **Code Style:**
  - Use consistent indentation and naming
  - Include proper comments and documentation
  - Provide usage instructions
  - Document TODOs and limitations

#### Environment Configuration

- **Environment Loading:**

  - Load from `.env` or `config.sh`
  - Declare global variables in config files
  - Update `.env.example` accordingly
  - Validate environment variables early

- **Dependencies:**
  - Add system packages to `preinstall.sh`

#### Error Handling and Logging

- **Error Handling:**

  - Use helper functions for logging (e.g., `echoDebug`, `error`, `warning`, `success`)
  - Validate inputs and environment early
  - Check function exit status with `checkFailure`
  - Use `set -e` for error handling where appropriate

- **Logging:**
  - Include proper logging for debugging and monitoring
  - Use helper functions for consistent logging across scripts
  - Provide clear error messages and debugging information

#### Deployment and Utility Functions

- **Deployment Framework:**

  - Provide automated retry mechanisms for RPC issues
  - Wrap Foundry's deployment functionality
  - Handle deployment challenges with robust error recovery
  - Validate deployment requirements and dependencies

- **Function Organization:**
  - Group related functionality into logical modules
  - Use clear function names that describe their purpose
  - Implement proper parameter validation

#### User Interaction

- **Interface Design:**

  - Use clear prompts with descriptive instructions
  - Use tools like `gum choose` for enhanced usability
  - Provide helpful feedback and status updates
  - Include progress indicators for long-running operations

- **Documentation:**
  - Document TODOs and limitations
  - Provide usage instructions
  - Include examples of common use cases
  - Maintain clear help text and error messages

#### Conventions and Best Practices

- **Integration:**

  - Scripts should integrate seamlessly with the overall deployment pipeline
  - Use consistent patterns across all bash scripts
  - Follow project-wide naming conventions
  - Maintain compatibility with existing tooling

- **Maintenance:**
  - Keep scripts modular for easy maintenance
  - Use version control best practices
  - Test scripts thoroughly before deployment
  - Update documentation when making changes

## Deployment and Configuration

### Deployment Scripts

- **Location and Organization:**

  - Base location: `script/deploy/facets/`
  - ZKSync-specific scripts: `script/deploy/zksync/`
  - Deployment: `Deploy{ContractName}.s.sol`
  - Update: `Update{ContractName}.s.sol`

- **Script Structure:**

  - **Deployment Scripts:**

    - Inherit `DeployScriptBase`
    - Use JSON config with `stdJson` (if constructor args needed)
    - Call `deploy()` with `type({ContractName}).creationCode`

    **Constructor Arguments Pattern:**

    - **Facets WITHOUT constructor arguments:**

      ```solidity
      function run() public returns (FacetName deployed) {
        deployed = FacetName(deploy(type(FacetName).creationCode));
      }
      // NO getConstructorArgs() function needed
      ```

    - **Facets WITH constructor arguments:**

      ```solidity
      function run()
        public
        returns (FacetName deployed, bytes memory constructorArgs)
      {
        constructorArgs = getConstructorArgs();
        deployed = FacetName(deploy(type(FacetName).creationCode));
      }

      function getConstructorArgs() internal override returns (bytes memory) {
        // Read from config, encode arguments
        return abi.encode(arg1, arg2);
      }
      ```

    - Example JSON handling for constructor args:
      ```solidity
      string memory path = string.concat(root, "/config/{facetName}.json");
      address configValue = _getConfigContractAddress(
        path,
        string.concat(".{key}.", network, ".{subkey}")
      );
      ```

  - **Update Scripts:**
    - Inherit `UpdateScriptBase`
    - Call `update("{ContractName}")`
    - Use `getExcludes()` for special cases
    - Return array of excluded function selectors

### Configuration Files

- **deployRequirements.json:**

  - Location: `script/deploy/resources/deployRequirements.json`
  - Purpose: Dictates deployment rules and dependencies
  - Features:
    - Controls deployment rules and dependencies
    - Manages contract dependencies
    - Handles network-specific parameters
    - Specifies zero address restrictions
    - Defines required external config files
  - Usage: Used in `helperFunctions.sh` for deployment validation

- **targetState.json:**
  - Location: `script/deploy/`
  - Purpose: Version control and deployment tracking
  - Features:
    - Defines expected contract versions
    - Tracks deployments across networks
    - Manages environment-specific versions
  - Structure:
    - Network keys (e.g., `mainnet`, `arbitrum`)
    - Environment keys (e.g., `production`, `staging`)
    - Contract versions for facets, periphery, and core contracts
  - Source: Auto-created from a Google Sheet
  - Usage: Ensures version consistency across deployments

### Template-based Code Generation

- **Overview:**

  - Use `plop facet` to generate new facets
  - Templates stored in `templates/` folder

- **Template Files:**
  - All template files are stored in the `templates/` folder. These templates are used by the `plop facet` command to generate new facets and their associated files.

### Audit and Documentation

#### Audit Logs and Reports

**Audit Log Structure (`auditLog.json`):**

- **audits:** Entries with unique ID (`auditYYYYMMDD_X`)
  - `auditCompletedOn`: Date (DD.MM.YYYY or YYYY-MM-DD)
  - `auditedBy`: Name/firm
  - `auditorGitHandle`: (if applicable)
  - `auditReportPath`: PDF location
  - `auditCommitHash`: Audited commit
- **auditedContracts:** Maps contracts to audit IDs

**Report Storage:**

- Store PDFs in `audit/reports/`
- Individual contract format: `YYYY.MM.DD_ContractName(version).pdf`
- Multiple contracts format: `YYYY.MM.DD_CustomFileName.pdf`

#### Documentation

- **Primary Sources:**
  - `README.md`: Overview and setup
  - `/docs`: Technical documentation
  - `Deploy.md`: Deployment instructions

### GitHub Workflows

- **Sensitive Data:**

  - Use GitHub Secrets for sensitive data
  - Reference with `${{ secrets.SECRET_NAME }}`

- **File Structure and Comments:**

  - Begin with clear description (YAML comments)
  - Include descriptive comments throughout
  - Define triggers explicitly
  - Use conditional checks with `if:`
  - Name jobs and steps clearly
  - Include notification steps
  - Set explicit permissions with comments
  - Clear file headers
  - Descriptive comments for each step

- **Security:**
  - Set explicit permissions
  - Include notifications
  - Document permission requirements
