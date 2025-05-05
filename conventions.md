# Repository overview

- **Project name:** LI.FI
- **Purpose:** LI.FI is a cross-chain bridge aggregation protocol that ensures secure and efficient interoperability through robust smart contracts and automated processes.
- **Core components:**
  - **Smart contracts:** Primarily built using the Diamond Standard (EIP-2535) with modular facets for core functionality, along with supporting periphery contracts for extended features and integrations.
  - **Automation scripts:** Deployment, updating, and operational tasks.
  - **Tests:** Tests ensuring contract reliability and safety.
  - **Documentation:** Detailed guides, API specifications, and deployment instructions.

# Codebase structure

    /lifi
     ├── .github/           # Github workflows
     ├── audit/             # Audit reports and log
     ├── config/            # Configuration files
     ├── deployments/       # Deployment logs and addresses
     ├── docs/              # Project documentation, API specs, and guides
     ├── scripts/           # Deployment, updating, and automation scripts
     ├── src/               # All Solidity smart contracts - `.sol` files
     ├── tasks/             # Utility scripts or tasks
     ├── tests/             # Unit and integration tests - `.t.sol` files
     ├── README.md          # High-level project overview and setup instructions
     ├── conventions.md     # Repository conventions and guidelines (this file)

Follow the folder structure to locate resources and generate or modify code in accordance with these standards.

# Smart contract conventions

## Solidity standards and patterns

- **Solidity version:**
  All Solidity files must start with: pragma solidity `{version}`. The Solidity version is defined in foundry.toml. This ensures that the version declaration in the source files remains in sync with the configuration. Always refer to `foundry.toml` for the current version rather than storing duplicate information.

- **Design patterns:**
  - Use established patterns (e.g., Ownable for access control, EIP-2535 Diamond Standard for facet-based architectures).
  - Favor modular design to enhance reusability and security.
- **Security best practices:**

  - Validate constructor inputs rigorously: if an invalid value (e.g., `address(0)` or zero value) is provided, revert with a custom error such as `InvalidConfig`. Ensure tests cover these conditions.
  - Utilize reentrancy guards (e.g., OpenZeppelin’s `ReentrancyGuard` or the checks-effects-interactions pattern).
  - Optimize for gas efficiency with proper data structures and minimal state changes.

- **General rules for blank lines**

  - **Between sections**
    - Separate logical sections of the contract with a single blank line (e.g., state variables, events, constructor, functions).
  - **Between function declarations**

    - Add a single blank line between function declarations to improve readability.
    - No blank lines between function signature and function body.

  - **Inside functions**

    - Use a single blank line:

      - Before a new logical block (e.g., loop, condition, or function call).
      - After setting up state variables at the beginning of a function.
      - Before emitting an event for better visibility.

    - No unnecessary blank lines:
      - Between `if` statements and their respective `revert()` calls.
      - Before a `return` statement unless it's a separate logical block.

  - **Between structs, enums, and mappings**

    - A single blank line between structs and enums.
    - A single blank line between mappings and other declarations.
    - If mappings are consecutive and related, adhere them together without a blank line.
    - If mappings are logically different, separate them with a blank line.

  - **Between modifiers**

    - Place a single blank line between modifiers.

  - **Before events and errors**

    - Do not add a blank line between events and errors.

  - **Within tests (\*.t.sol)**

    - Add a blank line:
      - Between `vm.expectRevert()` and the function call it applies to.
      - Before `vm.stopPrank()`, if it's a separate logical block.
      - Before an assertion to separate it from execution logic.

  - **Between test cases**
    - Ensure a single blank line between test cases.

## Facet contract checklist

- All facet contracts must reside in `src/Facets/`.
- Facet contract names must include the word `Facet`.
- Facets must always include the following three functions:
  1. `_startBridge` – an internal function.
  2. `swapAndStartBridgeTokensVia{FacetName}`.
  3. `startBridgeTokensVia{FacetName}`.
- **General inheritance**
  Facet contracts typically inherit from a set of core contracts/interfaces to ensure standardized functionality. A typical facet contract inherits from:
  - **Interfaces**:
    - `ILiFi` - Defines the standard interface for all bridging operations.
  - **Libraries**:
    - `LibAsset` - Handles asset deposits, approvals, and transfers.
    - `LibSwap` - Provides swap-related utilities.
    - `LibAllowList` - Ensures only approved contract calls can be executed.
  - **Security and utility contracts**:
    - `ReentrancyGuard` - Protects against reentrancy attacks.
    - `SwapperV2` - Provides swapping functionality.
    - `Validatable` - Implements bridge data validation logic.
  - **External utility contracts**:
    - `ECDSA` - Used for signature verification.
- **Sender handling:**
  Confirm whether the use of `msg.sender` is justified. Especially if a facet needs to pass an address for refunds (named `refundAddress` or `depositor` or similar) to the bridge itself, we discourage the use of msg.sender and instead recommend to use a dedicated parameter so the `refundAddress` can be specified independently of who sends/executes the transaction.

  Often, pass the “sender/depositor” as a parameter so refunds return directly to the user.

- **Parameter adjustments:**
  After a swap, verify if facet-specific parameters (e.g., expected `outputAmount`) require adjustment based on the actual swap outcome. This is especially relevant for intent-based bridges, where execution paths may vary, leading to deviations in expected amounts.
- **Parameter ordering:**
  For facets with a `receiverAddress` parameter, it should be the first parameter in the `{facetName}Data` struct.
  The receiverAddress must always be explicitly validated against `bridgeData.receiver` in the function logic:
  ```
  if (
      (bridgeData.receiver != {facetName}Data.receiverAddress)
  ) revert InformationMismatch();
  ```
  This ensures that funds are always sent to the correct recipient and prevents potential misrouting due to incorrectly passed parameters.
- **Cross-verification:**
  If `facetData` contains a `targetChainId`, the facet must verify it against `bridgeData.destinationChain` to ensure these values match. This check applies only to EVM-to-EVM transactions.
- **Modifiers:**
  Each facet must properly use the following modifiers:

  - `nonReentrant` - Prevents reentrancy attacks by ensuring that functions cannot be called recursively within the same transaction.
  - `refundExcessNative` - Ensures that any excess native tokens sent to the contract are refunded to the user after execution.
  - `validateBridgeData` - Ensures that the bridgeData is valid, including nonzero addresses, positive amounts, and a different destination chain.
  - `doesNotContainSourceSwaps` / `doesContainSourceSwaps` - Enforces whether source swaps are expected or not, preventing unintended swaps.
  - `doesNotContainDestinationCalls` / `doesContainDestinationCalls` - Ensures that destination calls are only included when expected, avoiding accidental post-bridge execution.

- **Events:**

  1. Transaction Start:

     - Event: `LiFiTransferStarted`
     - When to emit: At the start of a successful transaction, before any external calls.
     - Purpose: Enables tracking of bridge transactions.

     ```
     emit LiFiTransferStarted(bridgeData);
     ```

  2. Transaction Completion:

     - Event: `LiFiTransferCompleted`
     - When to emit: After a transaction is successfully executed and the funds have arrived at the destination.
     - Purpose: Signals that the bridge transaction was finalized.

  3. Transaction Recovery:
     - Event: `LiFiTransferRecovered`
     - When to emit: If a transaction fails or is refunded and the original sender recovers their funds.
     - Purpose: Ensures visibility for recoveries and refunds.

- **Fee handling:**
  For native fees, the facet must use the `_depositAndSwap` variant that reserves the required fee before execution. This ensures that native assets needed for bridging are deducted correctly.
- **Non-EVM chain support:**
  For transactions targeting non-EVM chains (e.g., Bitcoin, Solana):
  - The `receiverAddress` must be declared as `bytes` (not `bytes32`).
  - The facet must ensure that the non-EVM address is not zero, enforcing this with:
    ```
    if ({facetName}Data.receiverAddress == bytes32(0)) {
        revert InvalidNonEVMReceiver(
            {facetName}Data.receiverAddress,
            bytes32(0)
        );
    }
    ```
  - When a non-EVM address is used, the `bridgeData.receiver` must contain `LibAsset.NON_EVM_ADDRESS`, ensuring proper handling:
    ```
    if (
        bridgeData.receiver != LibAsset.NON_EVM_ADDRESS
    ) {
        revert InvalidCallData();
    }
    ```

## Solidity test conventions (.t.sol files)

- **File naming and structure**

  - Test files must have a `.t.sol` extension (e.g., `AcrossFacetV3.t.sol`, `DeBridgeDlnFacet.t.sol`, `DexManagerFacet.t.sol`).
  - Group and order imports with system libraries first and project files next.

- **Test function naming**

  - All tests that verify a successful execution (i.e., not expecting any reverts) must be prefixed with: `test_`
  - All tests that verify a failure case and expect a specific revert reason must be prefixed with: `testRevert_`. All negative tests must check for a specific revert reason. Usage of `vm.expectRevert()` without a reason is discouraged and should only be used in exceptional cases where the revert reason is dynamic.
  - Use clear and descriptive names that capture the test’s purpose. For example:
    1. `test_CanSwapAndBridgeTokensWithOutputAmountPercent`
    2. `testRevert_FailsIfCalledWithOutdatedQuote`
    3. `test_SucceedsIfOwnerAddsDex`
    4. `testRevert_FailsIfNonOwnerTriesToAddDex`
  - For base or inherited tests, prefix with `testBase_`.

- **Test structure and setup**

  - Every test contract must include a `setUp()` function to initialize the test environment.
  - The `setUp()` function typically configures custom block numbers, initializes base contracts, sets up facets, and assigns labels (using `vm.label`) for clarity.
  - Any contract that inherits from `TestBase.sol` must call `initTestBase()` in `setUp()` and set facet address.
  - Use `vm.startPrank(address)` and `vm.stopPrank()` to simulate transactions from different users.

- **Assertions and event testing**

  - Use `assertEq()` for checking equality of values (e.g., balances, contract addresses, return values).
  - Use custom assertion modifiers such as `assertBalanceChange()` to verify balance changes before and after transactions.
  - Before executing a function call that should emit an event, always use `vm.expectEmit(true, true, true, true, <contractAddress>)` to ensure the event parameters match and that the event is emitted by the correct contract.
  - Verify that the expected events (e.g., `AssetSwapped` or `LiFiTransferStarted`) are emitted with the intended parameters.

- **Overall test best practices**
  - Include comments where necessary to explain the purpose of tests or to clarify non-obvious behavior.
  - Maintain a consistent order in function calls and assertions.
  - Structure tests to first set up the state, then execute the function under test, and finally assert the expected outcomes.

## Solidity linter (solhint) configuration and rules

- **Solidity set rules**
  To maintain secure, consistent, and efficient Solidity code, we enforce the following Solhint configuration.
  - **Gas consumption and custom errors**
    `gas-custom-errors`: Enforce the use of custom errors to save gas during error handling.
  - **Security rules**
    - `avoid-sha3`: Use `keccak256` instead of the deprecated `sha3`.
    - `avoid-suicide`: Disallow the use of `selfdestruct` (formerly suicide).
    - `avoid-throw`: Enforce the use of `revert` or `require` instead of `throw`.
    - `avoid-tx-origin`: Prohibit reliance on `tx.origin` for authorization.
    - `check-send-result`: Require checking the return value of `send` to ensure transfers succeed.
    - `compiler-version`: Ensure contracts are compiled with a version matching `^0.8.17`.
    - `func-visibility`: Enforce explicit function visibility (excluding constructors).
    - `multiple-sends`: Discourage making multiple `send` calls within the same function.
    - `no-complex-fallback`: Prevent overly complex logic in fallback functions.
    - `no-inline-assembly`: Avoid using inline assembly to maintain code safety (this rule may be turned off if inline assembly is needed).
    - `not-rely-on-block-hash`: Do not use `blockhash` for security-critical operations.
    - `not-rely-on-time`: Avoid relying on block timestamps for critical logic.
    - `reentrancy`: Enforce reentrancy protections on functions that make external calls.
    - `state-visibility`: Require explicit visibility for state variables.
  - **Naming and ordering rules**
    - `use-forbidden-name`: Disallow reserved or ambiguous names.
    - `var-name-mixedcase`: Enforce mixedCase naming for variables.
    - `imports-on-top`: All import statements must be placed at the top of the file.
    - `visibility-modifier-order`: Enforce the proper order of visibility modifiers.
    - `immutable-vars-naming`: Immutable variables should be named in uppercase (like constants).
    - `func-name-mixedcase`: Function names must follow mixedCase notation.
    - `event-name-capwords`: Event names must use CapWords style.
    - `contract-name-capwords`: Contract names must be in CapWords style.
    - `const-name-snakecase`: Constant names must use snake_case.
    - `interface-starts-with-i`: Interfaces must start with the letter “I”.
    - `quotes`: Enforce the use of double quotes for string literals.

# Github workflows conventions

- **Sensitive data handling:**
  - Always use Github Secrets for all sensitive data (such as API keys, private keys, and RPC URLs).
  - Reference secrets using the syntax: `${{ secrets.SECRET_NAME }}`.
- **File header and purpose:**
  - Every workflow file must begin with a clear, concise description (using YAML comments) outlining its purpose.
  - Include descriptive comments throughout the file to explain the logic, conditions, and steps involved.
- **Trigger configuration and job structure:**
  - Define triggers explicitly (e.g., `workflow_dispatch`, `push`, `schedule`) with clear input descriptions when required.
  - Use conditional checks (via `if:`) to control the flow. For example, verify that a required input (such as typing “UNDERSTOOD” for emergency actions) is provided before proceeding.
  - Clearly name jobs and steps to reflect the action being performed (e.g., “Authenticate Git User”, “Pause Diamond”, “Send Slack Notification”).
- **Notifications and alerts:**
  - Include steps to send notifications (e.g., to Slack) when critical operations occur.
- **Permission\*:**
  - Workflow permissions must always be set explicitly for security reasons with a comment describing why they are required.
    for reference: https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions#permissions

# Bash scripts

- **General script structure:**

  - Begin each Bash script with the proper shebang:

        #!/bin/bash

- **Organize code into modular functions:**
  - Use descriptive function names and clear sections (e.g., “Logging”, “Error handling and logging”, “Deployment functions”) to structure your script.
- **DRY principle:**
  - Extract common logic into helper files (e.g., `script/helperFunctions.sh`).
- **Environment and configuration:**
  - Always load environment variables from a `.env` or `config.sh` file and configuration parameters from a dedicated config file.
  - Declare global variables (like `CONTRACT_DIRECTORY`, `DEPLOY_SCRIPT_DIRECTORY`, etc.) in the `.env` or `config.sh` files so they are consistently available across all functions.
  - Remember to update `.env.example` or `config.example.sh` accordingly.
- **Error handling and logging:**
  - Use dedicated helper functions for logging (e.g., `echoDebug`, `error`, `warning`, `success`) stored in `script/helperFunctions.sh` to provide consistent, color-coded feedback.
  - Validate external inputs and environment variables early in the script, and exit with a clear error message if required variables are missing.
  - When calling any underlying child function, immediately check its exit status using the `checkFailure` helper function. This ensures that if a function fails, the script halts further execution, preventing cascading errors.
  - If installing a new system package, add it to `preinstall.sh` so that developers have a unified initial installation procedure.
- **User interaction and prompts:**
  - When user input is needed (e.g., selecting a network or confirming an action), use clear prompts with descriptive instructions. Tools like `gum choose` can enhance usability.
  - Document any TODOs and known limitations clearly at the beginning of the script for future improvements.
- **Code readability and maintenance:**
  - Use consistent indentation, naming conventions, and comments throughout the script.
  - Provide usage instructions at the top of each script if applicable.
  - Separate core operations (e.g., deploying contracts, updating logs) into distinct, well-documented functions to facilitate easier maintenance and testing.

# Audit logs and reports conventions

- **Audit log file (`auditLog.json`):**
  Contains two main sections:
  1. **audits:** Each audit entry has a unique ID (e.g., `auditYYYYMMDD_X`) where `YYYYMMDD` = Audit completion date, `_X` = Incrementing counter for multiple audits on the same day. Ensure that contract versioning is consistent between the code and the `auditLog.json`.
  - Essential fields for each audit entry:
    - `auditCompletedOn`: Date in `DD.MM.YYYY` or `YYYY-MM-DD` format.
    - `auditedBy`: Name or firm.
    - `auditorGitHandle`: (if applicable).
    - `auditReportPath`: PDF location in `audit/reports/`.
    - `auditCommitHash`: The commit hash that was audited (or “n/a” if not tracked).
  2. **auditedContracts:** Maps contract names and versions to the relevant audit IDs in the audits section.
- **Storing reports:**
  Place PDF reports in the `audit/reports/` directory. The naming format must follow:
  - For individual contract audits use format `YYYY.MM.DD_ContractName(version).pdf` (e.g., `2025.01.17_LiFiDexAggregator(v1.3.0).pdf`).
  - For audits covering multiple contracts within a single file use the format: `YYYY.MM.DD_CustomFileName.pdf` (e.g., `2025.01.17_CantinaCompetitionFullCodebaseReview.pdf`).
    - Entries in the audit log should link individual contracts to this report.
- **Adding new audits:**
  For new or updated contracts, add an entry under audits with the correct date, auditReportPath, and auditCommitHash. Then, reference that new ID in auditedContracts for each relevant version.

# Documentation and references

- **Primary documentation:**
  - `README.md`: Contains an overview and setup instructions.
  - `/docs`: Contains detailed technical documentation, API specifications, and deployment guides.

# Deployment and update scripts

Deployment and update scripts for LI.FI smart contracts are located in: `script/deploy/facets/`. Each contract has a corresponding `Deploy` and `Update` script. These scripts ensure that contract deployments and upgrades follow a structured and consistent approach.

- **Naming conventions:**
  - Deployment scripts must be prefixed with `Deploy` followed by the contract name (e.g., `DeployMayanFacet.s.sol`).
  - Update scripts must be prefixed with `Update` followed by the contract name (e.g., `UpdateMayanFacet.s.sol`).
- **Structure of Deployment scripts:**
  - Each deployment script follow this format:
    - Inherits `DeployScriptBase` to maintain consistency.
    - Uses JSON config (`stdJson`) to fetch contract-specific configuration data.
    - Optionally defines `getConstructorArgs()` if the contract has constructor arguments.
    - Encodes constructor arguments before deployment.
    - Calls `deploy()` using `type({ContractName}).creationCode`.
- **Structure of Update scripts:**
  - Each deployment script follow this format:
    - Inherits `UpdateScriptBase` for consistency in update logic.
    - Calls `update("{ContractName}")` to handle facet upgrades in the Diamond architecture.
    - Ensures correct function selectors are updated.
  - Special Case: Some facets may require the exclusion of certain function selectors during updates. This is handled using `getExcludes()`:
    - Define an instance of the contract (`contractInstance`).
    - Use `.selector` to exclude specific functions.
    - Return an array containing function selectors to be excluded.
- **Configuration and JSON handling:**
  - If the contract has constructor arguments, each deployment script references JSON config files under `/config/`
    - The script dynamically selects values based on the network using:
      ```
      string memory path = string.concat(root, "/config/{facetName}.json");
      address {configValueVariableName} = _getConfigContractAddress(
        path,
        string.concat(".{key}.", network, ".{subkey}")
      );
      ```
      This allows fetching various values such as bridges, allowed tokens, and other necessary configurations dynamically based on the network and facet needs.

# Template-based code generation

- **Overview:**
  - To streamline the creation of new facets, we use plopfile.mjs, which automates the generation of contract templates, test files, documentation, and deployment scripts. The generator is triggered by running: `plop facet`
- **Template files** - All template files are stored in the `templates/` folder. Below is a breakdown of the different templates and their purposes:
  - **Facet** smart contract (`facet.template.hbs`): Defines the structure of the new contract facet, including storage, events, and core functions. Extension - `.sol`.
  - **Configuration** file (`facetConfig.template.hbs`): Stores configuration settings such as addresses and allowed tokens. Extension - `.json`.
  - **Deployment** script (`facetDeployScript.template.hbs`): Automates the contract deployment process. Extension - `.s.sol`.
  - **Update** script (`facetUpdateScript.template.hbs`): Manages contract upgrades using the Diamond Standard. Extension - `.s.sol`.
  - **Test** file (`facetTest.template.hbs`): Provides a testing framework for the new facet. Extension - `.t.sol`.
  - **Demo** script (`facetDemoScript.template.hbs`): Offers a sample script for interacting with the facet. Extension - `.ts`.
  - **Documentation** (`facetDoc.template.hbs`): Generates a Markdown file explaining the facet's purpose and usage. Extension - `.md`.

# Understanding `deployRequirements.json` and its role in deployment scripts

- **Overview:**
  - The `deployRequirements.json` file located at `script/deploy/resources/deployRequirements.json` serves as a configuration file that dictates how contract deployments should be handled in the deployment scripts. This JSON file contains specific deployment rules, contract dependencies, and necessary configurations to ensure smooth and controlled contract deployment.
- **Structure and purpose:**
  - It specifies whether a contract is allowed to be deployed with a zero address (typically restricted to avoid misconfigurations).
  - Some contracts require external configuration files that store network-specific parameters such as bridge addresses and token addresses.
  - The placeholders like `<NETWORK>` are dynamically replaced during script execution to fetch the correct addresses depending on the blockchain network being deployed to.
- **How it’s used in helperFunctions.sh:**
  - Within the deployment scripts, particularly in `helperFunctions.sh` in `checkDeployRequirements()` function, this JSON file plays a critical role in contract deployment and logging. The script reads and processes `deployRequirements.json` to:
    - Ensures contracts adhere to rules regarding zero addresses.
    - Reads configuration files specified for each contract.
    - Replaces placeholders like `<NETWORK>` with the actual deployment network.

# Understanding `targetState.json` and its role in deployment scripts

- **Overview:**

  - The `targetState.json` file stored in folder `script/deploy/` defines the expected contract versions for each blockchain network in different environments (e.g., `production`, `staging`). It ensures that all deployed contracts match their intended versions, preventing inconsistencies across deployments.

- **Structure and purpose:**
  - The file is structured as follows:
    - Each top-level key represents a blockchain network (e.g., `mainnet`, `arbitrum`, `avalanche`).
    - Under each network, different environments (e.g., `production`, `staging`) store deployment details.
    - The file tracks various facet contracts, periphery contracts, and core contracts (e.g., `AccessManagerFacet`, `GenericSwapFacet`, `LiFiDiamond`), ensuring that each contract has a predefined target version.
- **Key purposes:**
  - Ensures that contract versions across networks remain uniform.
  - The deployment scripts compare actual deployed versions with those in `targetState.json` and update contracts if needed.
  - Supports tracking and rolling out new versions for modular Diamond contracts.
