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
    - LDA-specific errors should be defined in `src/Periphery/LDA/LiFiDEXAggregatorErrors.sol`
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
   - Incorrect format (do not use):
     ```solidity
     /** @notice Brief description of function purpose
      * @param parameterName Description of parameter
      * @return Description of return value
      * @dev Additional details about implementation (optional)
      */
     ```
   - Always use `///` single-line format instead of `/** */` block format for better readability and gas efficiency

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

## LiFiDEXAggregator (LDA) Conventions

The LiFiDEXAggregator (LDA) is a specialized component within the LI.FI ecosystem that provides efficient, modular DEX integration capabilities through its own Diamond Standard implementation.

### Architecture Overview

#### Core Components

- **LiFiDEXAggregatorDiamond.sol**: Base EIP-2535 Diamond Proxy Contract for DEX Aggregator
- **CoreRouteFacet.sol**: Orchestrates route execution using direct function selector dispatch
- **BaseRouteConstants.sol**: Shared constants across DEX facets
- **PoolCallbackAuthenticator.sol**: Abstract contract providing pool callback authentication

#### Location Structure

```
src/Periphery/LDA/
├── LiFiDEXAggregatorDiamond.sol              # LiFiDEXAggregatorDiamond Diamond proxy implementation
├── BaseRouteConstants.sol      # Common constants for DEX facets
├── PoolCallbackAuthenticator.sol # Callback authentication base
├── Facets/                     # LiFiDEXAggregator-specific facets
│   ├── CoreRouteFacet.sol      # Route orchestration
│   ├── UniV3StyleFacet.sol     # UniV3-style DEX integrations
│   ├── UniV2StyleFacet.sol     # UniV2-style DEX integrations
│   ├── NativeWrapperFacet.sol  # Native token wrapping
│   └── {DexName}Facet.sol      # Custom DEX integrations
└── Errors/
    └── Errors.sol              # LiFiDEXAggregator-specific error definitions
```

### DEX Integration Decision Tree

When integrating a new DEX, follow this decision tree:

1. **Is the DEX a UniV3 fork (same logic, different callback name)?**
   - ✅ Yes → Extend `UniV3StyleFacet.sol` with a new callback
   - Add tests inheriting `BaseUniV3StyleDEXFacetTest`

2. **Else, is it a UniV2-style fork?**
   - ✅ Yes → No new facet needed
   - Add tests inheriting `BaseUniV2StyleDEXFacetTest`

3. **Else, does it use a callback?**
   - ✅ Yes → Create new custom facet with swap function and callback
   - Write tests inheriting `BaseDEXFacetWithCallbackTest`

4. **Else** → Create new custom facet with swap function without callbacks
   - Write tests inheriting `BaseDEXFacetTest`

### LiFiDEXAggregator Facet Requirements

#### Naming and Location

- Must reside in `src/Periphery/LDA/Facets/`
- Names must include "Facet" suffix
- Use descriptive names (e.g., `UniV3StyleFacet`, `CurveFacet`)

#### Required Inheritance

- **BaseRouteConstants**: For common constants (`DIRECTION_TOKEN0_TO_TOKEN1`, `FUNDS_IN_RECEIVER`)
- **PoolCallbackAuthenticator**: For facets requiring callback verification
- **No ReentrancyGuard**: CoreRouteFacet handles reentrancy protection

#### Function Patterns

**Swap Functions:**
- Must follow pattern: `swap{DexName}(bytes memory swapData, address from, address tokenIn, uint256 amountIn)`
- Use `LibPackedStream` for efficient parameter unpacking
- Handle token transfers based on `from` parameter (if `from == msg.sender`, pull tokens)

**Callback Functions:**
- Must use `onlyExpectedPool` modifier
- **IMPORTANT**: Callback function names are protocol-specific and cannot be guessed. You must inspect the target pool contract's interface directly in the block explorer or source code to determine the exact callback function name(s). Examples include `uniswapV3SwapCallback`, `pancakeV3SwapCallback`, `swapX2YCallback`, `swapY2XCallback`, etc.
- Use `LibCallbackAuthenticator` for pool verification

#### Parameter Handling

- **swapData Encoding**: Use packed encoding for efficiency
  - Common pattern: `[pool, direction, destinationAddress]`
  - Additional parameters as needed per DEX
- **Direction Parameter**: Use `uint8` where `1 = token0 -> token1`, `0 = token1 -> token0`
- **Validation**: Always validate pool addresses and amounts. For invalid inputs, revert with `InvalidCallData()` from `GenericErrors.sol`

#### Error Handling

- **LiFiDEXAggregator-specific errors**: Define in `src/Periphery/LDA/LiFiDEXAggregatorErrors.sol`
- **Generic errors**: Use existing errors from `src/Errors/GenericErrors.sol`

### LiFiDEXAggregator Testing Conventions

#### Test File Structure

```
test/solidity/Periphery/LDA/
├── BaseCoreRoute.t.sol           # Base route testing functionality
├── BaseDEXFacet.t.sol                # Base for custom DEX tests
├── BaseDEXFacetWithCallback.t.sol    # Base for callback-enabled DEX tests
├── BaseUniV3StyleDEXFacet.t.sol      # Base for UniV3-style DEX tests
├── BaseUniV2StyleDEXFacet.t.sol      # Base for UniV2-style DEX tests
└── Facets/
    └── {DexName}Facet.t.sol          # Specific DEX implementation tests
```

#### Test Implementation Requirements

**All LDA DEX tests must implement:**

1. **`_setupForkConfig()`**: Configure network and block number
   - Use valid `networkName` from `config/networks.json`
   - **IMPORTANT**: You must manually specify a block number where the target pools have healthy liquidity. Do not guess block numbers - check the pool's transaction history on a block explorer to find a recent block with sufficient reserves for testing
   - Example:
     ```solidity
     function _setupForkConfig() internal override {
         forkConfig = ForkConfig({
             networkName: "mainnet",
             blockNumber: 18500000  // Manually verified block with healthy pool liquidity
         });
     }
     ```

2. **`_createFacetAndSelectors()`**: Deploy facet and return selectors
   - Return facet address and function selectors for diamond cut
   - Include both swap function and callback selectors (if applicable)

3. **`_setFacetInstance()`**: Connect test handle to diamond proxy
   - Set local facet instance to diamond address after cut

4. **`_setupDexEnv()`**: Configure test tokens and pools
   - Set `tokenIn`, `tokenOut`, `poolInOut` with sufficient liquidity
   - Verify pools exist and have proper reserves

#### Test Categories by Inheritance

**BaseDEXFacetTest** (Custom DEX without callbacks):
- Implement single-hop and multi-hop tests (if supported)
- Focus on direct swap execution
- Example: `SyncSwapV2Facet.t.sol`

**BaseDEXFacetWithCallbackTest** (Custom DEX with callbacks):
- Include callback verification tests
- Override `_getCallbackSelector()` for negative tests
- Implement `_deployNoCallbackPool()` if needed
- Example: `IzumiV3Facet.t.sol`

**BaseUniV3StyleDEXFacetTest** (UniV3 forks):
- Override `_getCallbackSelector()` for DEX-specific callback
- No multi-hop support (skipped for UniV3-style)
- Example: `AlgebraFacet.t.sol`

**BaseUniV2StyleDEXFacetTest** (UniV2 forks):
- Override `_getPoolFee()` for DEX-specific fee structure
- Support multi-hop routing
- Example: `VelodromeV2Facet.t.sol`

#### Test Validation Requirements

- **Liquidity Validation**: Ensure pools have sufficient liquidity for test amounts
- **Token Decimals**: Override `_getDefaultAmountForTokenIn()` for non-18 decimal tokens
- **Pool Verification**: Verify pool addresses exist and are correctly configured. Ensure the chosen fork block number has the pools deployed and contains sufficient liquidity for testing

### LiFiDEXAggregator Deployment Scripts

#### Location and Naming

- **Location**: `script/deploy/facets/LDA/`
- **Naming**: `Deploy{DexName}Facet.s.sol`
- **Pattern**: Follow standard deployment script structure

#### Deployment Script Structure

```solidity
// SPDX-License-Identifier: LGPL-3.0-only
pragma solidity ^0.8.17;

import { DeployScriptBase } from "../utils/DeployScriptBase.sol";
import { {DexName}Facet } from "lifi/Periphery/LDA/Facets/{DexName}Facet.sol";

contract DeployScript is DeployScriptBase {
    constructor() DeployScriptBase("{DexName}Facet") {}

    function run() public returns ({DexName}Facet deployed) {
        deployed = {DexName}Facet(deploy(type({DexName}Facet).creationCode));
    }
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

#### Helper Function Usage

- **Always use existing helper functions** when available instead of reimplementing functionality
- Common helper functions to check for:

  - `getDeployments()` from `script/utils/deploymentHelpers.ts` for loading deployment files
  - `getProvider()` and `getWalletFromPrivateKeyInDotEnv()` from `script/demoScripts/utils/demoScriptHelpers.ts`
  - `sendTransaction()` for transaction execution
  - `ensureBalanceAndAllowanceToDiamond()` for token approvals
  - `getUniswapData*()` functions for swap data generation

- Before implementing new functionality, search the codebase for existing helper functions
- Helper functions provide consistent error handling, logging, and type safety across the project

#### Type Safety for Bridge Data

- **Always use proper typechain types** instead of `any` or custom types
- Use `ILiFi.BridgeDataStruct` from typechain for bridge data

- Never use `any` types for bridge data or other contract-related structures

#### Testing Requirements for Helper Functions

- **100% unit test coverage required** for all new TypeScript helper functions
- Test files should be named `{helperName}.test.ts` and placed in the same directory as the helper
- **Use Bun's built-in test runner** with Jest-like syntax (`describe`, `it`, `expect`)
- Tests should cover:
  - All function parameters and return values
  - Edge cases and error conditions
  - Type safety verification
  - Default parameter behavior
  - All possible input combinations
- Include both positive and negative test cases
- Test files should be comprehensive and well-documented

#### TypeScript Test Setup

We use Bun's built-in test runner for TypeScript helper functions. Bun provides Jest-like syntax with `describe`, `it`, and `expect`.

**File Structure:**

```
script/
├── runTypescriptTests.ts    # Main test runner script
├── utils/
│   └── someHelper.ts
├── demoScripts/
│   └── utils/
```

**Test File Template:**

```typescript
import { functionToTest } from './helperFile'

describe('functionToTest', () => {
  it('should do something', () => {
    const result = functionToTest()
    expect(result).toBe(expectedValue)
  })
})
```

**Available Assertions:**

Bun's test runner provides Jest-compatible assertions:

- `expect(value).toBe(expected)` - Strict equality
- `expect(value).toBeInstanceOf(constructor)` - Type checking
- `expect(value).toBeDefined()` - Existence check
- `expect(value).toEqual(expected)` - Deep equality
- `expect(value).toHaveLength(length)` - Array/string length
- `expect(value).toMatchObject(object)` - Partial object matching
- `expect(fn).toThrow()` - Function throws error
- `expect(value).not.toEqual(expected)` - Negation

**Running Tests:**

- Single test file: `bun test path/to/test.test.ts`
- All TypeScript tests: `bun run test:ts` (automatically finds and runs all `.test.ts` files in `script/` directory)
- Specific test: `bun test path/to/specific.test.ts`

**Best Practices:**

- Test files should be self-contained and executable
- Use descriptive test names that explain the expected behavior
- Group related tests logically using `describe` blocks
- Test both success and failure scenarios
- Verify type safety where applicable
- Keep tests simple and focused on one aspect at a time

#### Code Quality and Linting Standards

- **Pre-Change Verification:**

  - Verify all imports and types exist before making changes
  - Check if typechain has been generated for new contracts
  - Ensure all referenced variables and functions are available

- **Comprehensive Changes:**

  - Make all related changes in a single update, not incrementally
  - Update all variable references consistently throughout the file
  - Ensure import statements match the actual available exports

- **Post-Change Validation:**

  - Run TypeScript compilation to catch type errors
  - Verify no unused imports remain
  - Check that all variable names are consistently updated
  - Ensure function signatures match their usage

- **Type Safety:**

  - Always use proper TypeScript types instead of `any`
  - Verify interface compatibility before using imported types
  - Use type guards when dealing with dynamic data

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
