---
name: deprecate-contract
description: Deprecate one or more facet or periphery contracts by removing them from the codebase
usage: /deprecate-contract <ContractName1> [ContractName2] [ContractName3] ...
---

# Deprecate Contract Command

> **Usage**: `/deprecate-contract <ContractName1> [ContractName2] [ContractName3] ...`

## Overview

This command completely removes one or more contracts (facets or periphery) from the codebase by:

- Dynamically discovering contract locations in `src/` (works with any folder structure)
- Analyzing all references to determine what needs to be removed
- **Replacing test files with similar bridge tests** (for bridge facets) to maintain or increase test coverage
- Removing source files, deployment scripts, docs, and config entries
- Updating whitelist for periphery contracts
- Running test suite to verify remaining tests pass
- Searching for remaining occurrences for manual review

## Quick Start

### Examples

```bash
# Single contract
/deprecate-contract RelayFacet

# Multiple contracts
/deprecate-contract RelayFacet RelayDepositoryFacet

# Mix of facet and periphery
/deprecate-contract RelayFacet Permit2Proxy TokenWrapper
```

## Execution Flow

The command performs these steps in order:

1. **Discovery & Validation**

   - Search `src/` directory tree for `{ContractName}.sol` files
   - Determine contract type (facet if name contains "Facet", otherwise periphery)
   - Display contracts to be deprecated for confirmation

2. **Reference Analysis**

   - Search codebase for all references to each contract
   - Identify files to remove:
     - Deployment scripts (`script/deploy/**/Deploy{ContractName}.s.sol`, `Update{ContractName}.s.sol`, zksync variants)
     - Test files (`test/solidity/**/{ContractName}.t.sol`)
     - Documentation (`docs/{ContractName}.md`)
     - Demo scripts (`script/demoScripts/demo{ContractName}.ts`)
   - Identify config entries to remove:
     - `script/deploy/resources/deployRequirements.json`
     - `script/deploy/_targetState.json` (all networks/environments)
     - `config/{contractNameLowercase}.json` (if contract-specific, or remove entries if shared)
     - `config/whitelist.json` and `config/whitelist.staging.json` (PERIPHERY section)
     - `config/global.json` (coreFacets/corePeriphery arrays)

3. **Test Coverage Preservation** (for bridge facets only)

   - **Measure baseline coverage**: Run `forge coverage --report lcov --force --ir-minimum`, filter with `bun script/utils/filter_lcov.ts lcov.info lcov-filtered.info 'test/' 'script/'`, and record line coverage percentage
   - **Find similar bridge**: Identify a similar active bridge facet (see "Test Replacement Strategy" below for criteria)
   - **Adapt and add tests**:
     - Copy relevant test patterns from the deprecated bridge test file
     - Adapt to the similar bridge (update contract names, imports, function selectors, constants, addresses, chain IDs)
     - Add adapted tests to the similar bridge's test file
     - Preserve test logic and assertions
   - **Verify new tests**: Run `forge test` to ensure newly added adapted tests pass (required per `.cursor/rules/099-finish.mdc`)

4. **Removal Operations**

   - Delete contract source files from discovered locations
   - Delete all deployment scripts (regular and zksync variants)
   - Remove contract entries from `deployRequirements.json`
   - Remove contract from `_targetState.json` (all networks/environments)
   - Remove or update config files:
     - Delete if contract-specific
     - Remove only contract-specific entries if shared with other contracts
   - Remove from whitelist configs (periphery contracts)
   - Remove from `global.json` core lists if present
   - Delete test files (only after successful replacement for bridge facets)
   - Delete documentation files
   - Delete demo scripts

5. **Post-Removal Updates**

   - For periphery contracts: Run `bun update-whitelist-periphery` once after all removals
   - **Verify coverage** (bridge facets only): Measure final coverage and compare with baseline from step 3; coverage must be maintained or increased (warn if decreased)
   - **Run full test suite**: Run `forge test` to verify ALL tests pass (required per `.cursor/rules/099-finish.mdc` - tests must pass after any Solidity changes)
   - Display summary of all changes including coverage comparison (if applicable)

6. **Remaining Occurrences Review**

   - **Search codebase**: Search entire codebase for all occurrences of contract name(s) (excluding generated dirs: `node_modules`, `.git`, `out`, `cache`, `broadcast`, `typechain`, `lib`)
   - **Group and present**: Group results by file with line numbers and context
   - **User review required**: Present organized list and explicitly prompt user to review each occurrence
   - **Wait for input**: Wait for user input before removing additional files (user must confirm which files/occurrences to clean up)
   - **Re-run tests if cleanup performed**: If user removes additional files in this step, run `forge test` again to ensure all tests still pass

7. **Final Reminders**

   - **⚠️ CRITICAL: Update Product Target State Spreadsheet**: Display prominent reminder with link to [Product Target State Spreadsheet](https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0) - user must manually move contract column(s) to deprecated section
   - **⚠️ Review codebase search results**: Remind user to carefully review all occurrences found in step 6 and clean up as needed

## Key Behaviors

### Dynamic Discovery

- Uses `find src/ -name "{ContractName}.sol"` to locate files (not hardcoded paths)
- Works with contracts in any `src/` subdirectory (Facets, Periphery, Security, Helpers, etc.)

### Config File Handling

- **Contract-specific**: Delete entire file if only used by deprecated contract
- **Shared config**: Remove only contract-specific entries, keep file if other contracts use it
- Example: If `relay.json` is shared, remove `relayReceiver`/`relaySolver` but keep `relayDepository` if used by `RelayDepositoryFacet`

### Target State Structure

- **Facets**: Removed from `LiFiDiamond` key in target state
- **Periphery**: Removed from root level in target state

### Test Replacement Strategy (Bridge Facets Only)

- **Never delete tests without replacement**: For bridge facets, tests must be replaced with similar bridge tests to maintain coverage
- **Similarity criteria** (in priority order):
  1. **Active status**: Target bridge must not be deprecated
  2. **Test structure similarity**: Similar setup patterns, test organization, and test naming conventions
  3. **Functional similarity**: Both support similar features (native tokens, ERC20 tokens, swap integration, cross-chain bridging)
- **Test adaptation requirements**:
  - Update: contract names, imports, function selectors, constants (addresses, chain IDs)
  - Preserve: test logic, assertions, test structure, edge cases
- **Coverage requirement**: Final coverage must be ≥ baseline coverage (measured in step 3, verified in step 5)

### Error Handling

- Contract not found: Warn but continue with other contracts
- Files not found: Skip silently (not an error)
- Invalid JSON: Error and abort
- Whitelist update fails: Warn but don't abort (deprecation already complete)
- Test failures: Report but don't abort (deprecation already complete)
- **No similar bridge found**: For bridge facets, if no similar bridge can be identified, ask user for guidance before proceeding
- **Coverage decrease**: If coverage decreases after test replacement, warn user and ask for confirmation before proceeding

## Files Modified

- `src/**/{ContractName}.sol` - Contract source (deleted)
- `script/deploy/**/Deploy{ContractName}.s.sol` - Deployment scripts (deleted)
- `script/deploy/**/Update{ContractName}.s.sol` - Update scripts (deleted)
- `script/deploy/**/Deploy{ContractName}.zksync.s.sol` - ZKSync deployment (deleted)
- `script/deploy/**/Update{ContractName}.zksync.s.sol` - ZKSync update (deleted)
- `script/deploy/resources/deployRequirements.json` - Removes contract entry
- `script/deploy/_targetState.json` - Removes from all networks/environments
- `config/{contractNameLowercase}.json` - Deleted if contract-specific, or entries removed if shared
- `config/whitelist.json` - Removes from PERIPHERY section
- `config/whitelist.staging.json` - Removes from PERIPHERY section
- `config/global.json` - Removes from coreFacets/corePeriphery arrays
- `test/solidity/**/{ContractName}.t.sol` - Test files (replaced with similar bridge tests for bridge facets, deleted for non-bridge contracts)
- `docs/{ContractName}.md` - Documentation (deleted)
- `script/demoScripts/demo{ContractName}.ts` - Demo scripts (deleted)

## Example Output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔍 Deprecating contract: RelayFacet
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Contract type: Facet

✓ Removed src/Facets/RelayFacet.sol
✓ Removed script/deploy/facets/DeployRelayFacet.s.sol
✓ Removed script/deploy/facets/UpdateRelayFacet.s.sol
✓ Removed script/deploy/zksync/DeployRelayFacet.zksync.s.sol
✓ Removed script/deploy/zksync/UpdateRelayFacet.zksync.s.sol
✓ Removed 'RelayFacet' from script/deploy/resources/deployRequirements.json
✓ Removed 'RelayFacet' from script/deploy/_targetState.json (all networks/environments)
✓ Removed entries from config/relay.json (relayReceiver and relaySolver)
⚠ Warning: config/relay.json still contains relayDepository entries (used by RelayDepositoryFacet) - keeping file

📊 Test Coverage Preservation
✓ Measured baseline coverage: 85.2% line coverage
✓ Identified similar bridge: StargateFacetV2 (similar swap integration, native token support)
✓ Adapted 12 test cases from RelayFacet.t.sol to StargateFacetV2.t.sol
✓ Added adapted tests to test/solidity/Facets/StargateFacetV2.t.sol
✓ Verified new tests pass
✓ Measured final coverage: 85.8% line coverage (+0.6%)
✓ Removed test/solidity/Facets/RelayFacet.t.sol

✓ Removed docs/RelayFacet.md
✓ Removed script/demoScripts/demoRelay.ts

✓ Running full test suite (required after Solidity changes per `.cursor/rules/099-finish.mdc`)...
✓ All tests passed

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Remaining Occurrences Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚠️  ACTION REQUIRED: Review all occurrences below and clean up as needed.

Found additional occurrences of "RelayFacet" in the codebase:

  📄 deployments/mainnet.json
     Line 45: "RelayFacet": "0x..."
     Total matches: 1

  📄 deployments/base.json
     Line 23: "RelayFacet": "0x..."
     Total matches: 1

  📄 script/demoScripts/utils/cowSwapHelpers.ts
     Line 8: import { RelayFacet__factory } from '../../typechain'
     Line 12: type RelayFacet
     Total matches: 2

  📄 typechain/index.ts
     Line 1234: export * from './RelayFacet'
     Total matches: 1

⚠️  Note:
- Deployment log files (deployments/*.json) may contain historical references
- TypeScript type files (typechain/) are generated and will be regenerated
- Some files may intentionally keep contract values for historical reference

Please review the above list and indicate which files/occurrences should be removed:
- Type the file paths you want to clean up
- Or say "none" if all occurrences should remain
- Or say "all" to remove all occurrences (use with caution)
- Or say "deployments only" to remove only from deployment log files

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  FINAL MANUAL STEPS REQUIRED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. ⚠️  Update Product Target State Spreadsheet:
   Action: Move the "RelayFacet" column to the deprecated section in the [Product Target State Spreadsheet](https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0).

2. ⚠️  Review codebase search results above:
   Action: Clean up any remaining occurrences as needed (deployments, typechain will regenerate, etc.)

Successfully deprecated RelayFacet.
```

## Validation Checklist

Before executing, validate:

- [ ] Contract exists in `src/` directory tree
- [ ] Contract name matches exactly (case-sensitive)
- [ ] Multiple contracts are space-separated
- [ ] Config file sharing checked (if shared, only entries removed, not file)

## Safety Features

- **Confirmation**: For multiple contracts, display summary before proceeding
- **Config file safety**: Only remove config files if contract-specific
- **Remaining occurrences review**: Present all matches for user review before removing
- **Test verification**: Run `forge test` after all changes to ensure ALL tests pass (required per `.cursor/rules/099-finish.mdc` - tests must pass after any Solidity changes, including test file modifications)

## Implementation Notes

### General Requirements

- Use exact string matching for contract names (case-sensitive)
- Preserve JSON formatting when editing files
- Support contracts in any `src/` subdirectory
- Support both facet and periphery contracts with appropriate handling
- Support deprecating multiple contracts in a single command
- Display clear, actionable error messages
- After completion, verify changes by checking that entries are actually removed

### Bridge Facet Test Replacement

- **Always replace tests**: Never delete bridge facet tests without replacement
- **Coverage measurement**: Use `forge coverage --report lcov --force --ir-minimum`, then filter with `bun script/utils/filter_lcov.ts lcov.info lcov-filtered.info 'test/' 'script/'`
- **Test adaptation**: Preserve test logic while updating contract-specific details (names, imports, selectors, addresses, chain IDs)
