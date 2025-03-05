# Repository overview

- **Project name:** LiFi  
- **Purpose:** LiFi is a cross-chain bridge aggregation protocol that ensures secure and efficient interoperability through robust smart contracts and automated processes.  
- **Core components:**
  - **Smart contracts:** Primarily built using the Diamond Standard (EIP-2535) with modular facets for core functionality, along with supporting periphery contracts for extended features and integrations.
  - **Automation scripts:** Deployment, migration, and operational tasks.
  - **Tests:** Tests ensuring contract reliability and safety.
  - **Documentation:** Detailed guides, API specifications, and deployment instructions.

# Codebase structure

    /lifi
     ├── src/               # Solidity smart contracts (Diamond facets + periphery) - `.sol` files
     ├── tasks/             # Utility scripts or tasks
     ├── scripts/           # Deployment, migration, and automation scripts
     ├── tests/             # Unit and integration tests - `.t.sol` files
     ├── docs/              # Project documentation, API specs, and guides
     ├── .github/           # Github workflows
     ├── config/            # Facets' configuration files
     ├── deployments/       # Deployment logs and addresses
     ├── audit/             # Audit reports and log
     ├── README.md          # High-level project overview and setup instructions
     ├── conventions.md     # Repository conventions and guidelines (this file)

Follow the folder structure to locate resources and generate or modify code in accordance with these standards.

# Smart contract conventions

## Solidity standards and patterns

- **Solidity version:**  
  All Solidity files must start with:

    pragma solidity ^0.8.17;

- **Design patterns:**  
  - Use established patterns (e.g., Ownable for access control, Diamond Standard for facets).  
  - Favor modular design to enhance reusability and security.
- **Security best practices:**  
  - Validate inputs using `require` statements.  
  - Validate constructor inputs rigorously: if an invalid value (e.g., `address(0)` or zero value) is provided, revert with a custom error such as `InvalidConfig`. Ensure tests cover these conditions.  
  - Utilize reentrancy guards (e.g., OpenZeppelin’s `ReentrancyGuard` or the checks-effects-interactions pattern).  
  - Optimize for gas efficiency with proper data structures and minimal state changes.

## Facet contract checklist

- Facets must always include the following three functions:
  1. `_startBridge` – an internal function.
  2. `swapAndStartBridgeTokensVia{FacetName}`.
  3. `startBridgeTokensVia{FacetName}`.
- **Sender handling:**  
  Confirm whether `msg.sender` is justified. Often, pass the “sender/depositor” as a parameter so refunds return directly to the user.
- **Parameter adjustments:**  
  After a swap, verify if facet-specific parameters (e.g., expected `outputAmount`) require adjustment based on the actual swap outcome.
- **Parameter ordering:**  
  For facets with a `receiverAddress` parameter, it should be the first parameter in the `facetData` struct and must match the `bridgeData.receiver`.
- **Cross-verification:**  
  If `facetData` contains a `targetChainId`, verify it against `bridgeData.destinationChain`.
- **Modifiers and events:**  
  Ensure usage of default modifiers (e.g., `nonReentrant`, `refundExcessNative`) and that the `LiFiTransferStarted` event is emitted.
- **Fee handling and non-evm support:**  
  For native fees, use the `_depositAndSwap` variant that reserves the fee. For non-evm chains (e.g., Bitcoin), ensure the `receiverAddress` is declared as `bytes` (not `bytes32`).

## Solidity tests conventions (.t.sol files)

- **File naming and structure**  
  - Test files typically have a `.t.sol` extension (e.g., `AcrossFacetV3.t.sol`, `DeBridgeDlnFacet.t.sol`, `DexManagerFacet.t.sol`).  
  - Each file should begin with the SPDX license identifier and the Solidity version:

        // SPDX-License-Identifier: Unlicense
        pragma solidity ^0.8.17;

  - Group and order imports with system libraries first and project files next.

- **Test function naming**  
  - Prefix test functions expected to pass with `test_`.  
  - Prefix test functions expected to revert with `testRevert_` (using `vm.expectRevert` to check for specific error selectors).  
  - Use clear and descriptive names that capture the test’s purpose. For example:  
    1. `test_CanSwapAndBridgeTokensWithOutputAmountPercent`  
    2. `testRevert_FailsIfCalledWithOutdatedQuote`  
    3. `test_SucceedsIfOwnerAddsDex`  
    4. `testRevert_FailsIfNonOwnerTriesToAddDex`  
  - For base or inherited tests, prefix with `testBase_`.

- **Test structure and setup**  
  - Every test contract must include a `setUp()` function to initialize the test environment.  
  - The `setUp()` function typically configures custom block numbers, initializes base contracts, sets up facets, and assigns labels (using `vm.label`) for clarity.  
  - Common initialization steps include calling `initTestBase()` and setting facet addresses in the test base.  
  - Use `vm.startPrank(address)` and `vm.stopPrank()` to simulate transactions from different users.

- **Assertions and event testing**  
  - Use `assertEq()` for checking equality of values (e.g., balances, contract addresses, return values).  
  - Use custom assertion modifiers such as `assertBalanceChange()` to verify balance changes before and after transactions.  
  - Before executing a function call that should emit an event, use `vm.expectEmit()` with appropriate flags (to check indexed parameters) and the expected event signature.  
  - Verify that the expected events (e.g., `AssetSwapped` or `LiFiTransferStarted`) are emitted with the intended parameters.

- **Reversion and error handling**  
  - Negative test cases should use `vm.expectRevert()` with the exact error selector (e.g., `InvalidQuoteTimestamp.selector`, `UnAuthorized.selector`).  
  - The test name must reflect that the function is expected to fail (using the `testRevert_` prefix).  
    - For example:
      - `testRevert_FailsIfCalledWithOutdatedQuote` verifies that a call reverts when the quote timestamp is outdated.
      - `testRevert_FailsIfNonOwnerTriesToAddDex` ensures that unauthorized addresses cannot perform owner-only actions.

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
  - Remember to update `.env.example` or `config.example.sh` accordingly.  
  - Declare global variables (like `CONTRACT_DIRECTORY`, `DEPLOY_SCRIPT_DIRECTORY`, etc.) in the `.env` or `config.sh` files so they are consistently available across all functions.
- **Error handling and logging:**  
  - Use dedicated helper functions for logging (e.g., `echoDebug`, `error`, `warning`, `success`) to provide consistent, color-coded feedback.  
  - Validate external inputs and environment variables early in the script, and exit with a clear error message if required variables are missing.  
  - **Child function failure checking:** When calling any underlying child function, immediately check its exit status using the `checkFailure` helper function. This ensures that if a function fails, the script halts further execution, preventing cascading errors.  
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
  1. **audits:** Each audit entry has a unique ID (e.g., `auditYYYYMMDD`), an auditCompletedOn date, auditedBy, auditorGitHandle (if applicable), auditReportPath (PDF location in `audit/reports/`), and an auditCommitHash.
  2. **auditedContracts:** Maps contract names and versions to the relevant audit IDs in the audits section.
- **Storing reports:**  
  Place PDF reports in the `audit/reports/` directory, using a naming format that includes the date and contract info (e.g., `2025.01.17_LiFiDexAggregator(v1.3.0).pdf`).
- **Adding new audits:**  
  For new or updated contracts, add an entry under audits with the correct date, auditReportPath, and auditCommitHash. Then, reference that new ID in auditedContracts for each relevant version.
- **Naming and versioning:**  
  Use a format like `auditYYYYMMDD` for unique IDs and ensure that contract versioning is consistent between the code and the `auditLog.json`.
- **Essential fields:**  
  - `auditCompletedOn`: Date in `DD.MM.YYYY` or `YYYY-MM-DD` format.  
  - `auditedBy`: Name or firm.  
  - `auditorGitHandle`: (if applicable).  
  - `auditReportPath`: PDF location in `audit/reports/`.  
  - `auditCommitHash`: The commit hash that was audited (or “n/a” if not tracked).

# Documentation and references

- **Primary documentation:**  
  - `README.md`: Contains an overview and setup instructions.  
  - `/docs`: Contains detailed technical documentation, API specifications, and deployment guides.