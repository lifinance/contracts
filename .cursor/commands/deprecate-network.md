---
name: deprecate-network
description: Deprecate one or more networks by removing entries from networks.json, foundry.toml, and deployment logs
usage: /deprecate-network <network1> [network2] [network3] ...
---

# Deprecate Network Command

> **Usage**: `/deprecate-network <network1> [network2] [network3] ...`

## Overview

This command completely removes a network (or multiple networks) from the codebase by:

1. Removing the network entry from `config/networks.json`
2. Removing the RPC endpoint entry from `foundry.toml` under `[rpc_endpoints]`
3. Removing the etherscan entry from `foundry.toml` under `[etherscan]`
4. Removing the network entry from `script/deploy/_targetState.json` (removes both production and staging environments)
5. Removing all deployment log files in `deployments/` directory that match the network name pattern
6. Automatically updating the whitelist by running `bun update-whitelist-periphery`

## How to Use

1. Type `/deprecate-network` followed by one or more network names (space-separated)
2. The command will automatically:
   - Validate that the networks exist in `config/networks.json`
   - Remove network entries from `config/networks.json`
   - Remove RPC endpoint entries from `foundry.toml`
   - Remove etherscan entries from `foundry.toml`
   - Remove network entries from `script/deploy/_targetState.json`
   - Delete all deployment log files matching the network pattern
   - Automatically run `bun update-whitelist-periphery` to update the whitelist
   - Display a summary of all changes made

## Examples

### Deprecate a single network:

```
/deprecate-network fantom
```

### Deprecate multiple networks:

```
/deprecate-network fantom harmony evmos
```

## Execution Steps

When `/deprecate-network` is invoked with network names:

1. **Validate network names**:

   - Read `config/networks.json` to verify all specified networks exist
   - If a network doesn't exist, warn the user but continue with other networks
   - Display list of networks to be deprecated for confirmation

2. **Remove from `config/networks.json`**:

   - Read the JSON file
   - For each network, remove the entire network object (e.g., `"fantom": { ... }`)
   - Write the updated JSON back to the file
   - Preserve JSON formatting and indentation

3. **Remove from `foundry.toml` - RPC endpoints**:

   - Read `foundry.toml`
   - Locate the `[rpc_endpoints]` section
   - For each network, remove the line: `{network} = "${ETH_NODE_URI_{NETWORK}}"` (case-insensitive matching)
   - Preserve TOML formatting and comments

4. **Remove from `foundry.toml` - Etherscan**:

   - Locate the `[etherscan]` section
   - For each network, remove the entire etherscan entry block:
     ```toml
     {network} = { key = "...", url = "...", chain = "..." }
     ```
   - Handle entries that may span multiple lines
   - Preserve TOML formatting and comments

5. **Remove from `script/deploy/_targetState.json`**:

   - Read the target state JSON file
   - For each network, remove the entire network entry (e.g., `"fantom": { ... }`)
   - This removes both production and staging environments for the network
   - Use `jq` to remove the network: `jq 'del(.["{network}"])'` or equivalent
   - Write the updated JSON back to the file
   - Preserve JSON formatting and indentation
   - If the network doesn't exist in target state, skip silently (not an error)

6. **Remove deployment log files**:

   - For each network, delete all files in `deployments/` directory matching:
     - `{network}.json`
     - `{network}.staging.json`
     - `{network}.diamond.json`
     - `{network}.diamond.staging.json`
   - Use case-insensitive matching for network names
   - If a file doesn't exist, skip silently (not an error)

7. **Update whitelist**:

   - Automatically execute `bun update-whitelist-periphery` command
   - This ensures the whitelist configuration is updated to reflect the deprecated networks
   - If the command fails, report the error but don't abort (the network deprecation is already complete)
   - Display the command output for verification

8. **Remind user to update Product Target Sheet**:

   - Display a prominent reminder to manually update the Product Target State spreadsheet
   - The spreadsheet tracks contract deployments across networks: [Product Target State spreadsheet](https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0)
   - For deprecated networks: Move the network row(s) to the deprecated section
   - This is a manual step that must be done separately as the spreadsheet is not part of the codebase

9. **Display summary**:

   - List all networks successfully deprecated
   - List all files removed
   - List any warnings (e.g., network not found in networks.json, but found in foundry.toml)
   - Display any errors encountered

10. **Search for remaining occurrences**:

- For each deprecated network, search the entire codebase for occurrences of the network name
- Use case-insensitive search to find all matches (e.g., `grep -ri "fantom" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=out --exclude-dir=cache --exclude-dir=broadcast --exclude-dir=typechain --exclude-dir=lib`)
- Exclude generated directories: `node_modules`, `.git`, `out`, `cache`, `broadcast`, `typechain`, `lib`
- Group results by file path, sorted alphabetically
- For each file, show:
  - File path (relative to workspace root)
  - Total number of matches in that file
  - Sample of matches (first 2-3 lines with line numbers and context)
- Present a concise, organized list to the user with clear formatting
- **Important notes**:
  - Some files like `config/*.json` may intentionally keep network values for historical reference
  - Files in `archive/` directory are typically historical and may be kept
  - Test files may reference networks for testing purposes
- Ask the user to review the list and indicate which files/occurrences should be removed
- Wait for user input before proceeding with any additional removals
- Format options for user response:
  - List specific file paths to clean up
  - Say "none" if all occurrences should remain
  - Say "all" to remove all occurrences (use with caution)
  - Say "config only" to remove only from config files (excluding archive/)

## File Patterns

### Deployment Log Files to Remove

For a network named `fantom`, remove:

- `deployments/fantom.json`
- `deployments/fantom.staging.json`
- `deployments/fantom.diamond.json`
- `deployments/fantom.diamond.staging.json`

### Foundry.toml Entries to Remove

**RPC Endpoints section** (`[rpc_endpoints]`):

```toml
fantom = "${ETH_NODE_URI_FANTOM}"
```

**Etherscan section** (`[etherscan]`):

```toml
fantom = { key = "${MAINNET_ETHERSCAN_API_KEY}", url = "https://api.etherscan.io/v2/api?chainid=250", chain = "250" }
```

### Target State File to Remove

**Target State file** (`script/deploy/_targetState.json`):

```json
{
  "fantom": {
    "production": { ... },
    "staging": { ... }
  }
}
```

The entire `"fantom"` entry (including both production and staging) will be removed.

## Validation Checklist

Before executing, validate:

- [ ] **Network exists**: Verify network exists in `config/networks.json` (warn if not found, but continue)
- [ ] **Network name format**: Network names should match exactly (case-sensitive) as they appear in `config/networks.json`
- [ ] **Multiple networks**: Support space-separated list of networks
- [ ] **File existence**: Check if deployment files exist before attempting deletion (not an error if missing)
- [ ] **JSON formatting**: Preserve proper JSON formatting when removing from `config/networks.json`
- [ ] **TOML formatting**: Preserve proper TOML formatting and comments when removing from `foundry.toml`

## Error Handling

The command handles:

- Networks not found in `config/networks.json` (warn but continue)
- Networks not found in `foundry.toml` (warn but continue)
- Networks not found in `script/deploy/_targetState.json` (skip silently, not an error)
- Deployment files that don't exist (skip silently)
- Invalid JSON structure (error and abort)
- Invalid TOML structure (error and abort)
- File system errors (error and report)
- Partial failures (continue with remaining networks, report all errors at end)
- Whitelist update command failures (warn but don't abort - network deprecation is already complete)
- Remaining occurrences search: Exclude generated directories, group by file, show context
- User review of remaining occurrences: Wait for user input before removing additional files

## Safety Features

- **Dry-run option**: Consider showing what would be removed before actually removing (optional enhancement)
- **Confirmation**: For multiple networks, display summary before proceeding
- **Backup suggestion**: Recommend backing up files before deprecation (informational message)
- **Remaining occurrences review**: After deprecation, search codebase and present all matches for user review before removing

## Manual Steps Required

After the command completes, you **must** manually update the Product Target State spreadsheet:

- **Spreadsheet URL**: [Product Target State spreadsheet](https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0)
- **For deprecated networks**: Move the network row(s) to the deprecated section in the spreadsheet
- This spreadsheet tracks contract deployments across all networks and is used by the product team
- The command cannot automatically update this spreadsheet as it's external to the codebase

## Key Files Modified

- `config/networks.json` - Network configuration (removes network entries)
- `foundry.toml` - Foundry configuration (removes RPC and etherscan entries)
- `script/deploy/_targetState.json` - Target state configuration (removes network entries for both production and staging)
- `deployments/{network}*.json` - Deployment log files (deletes matching files)
- Whitelist configuration files - Updated via `bun update-whitelist-periphery` command

## Implementation Notes

- Use exact string matching for network names (case-sensitive)
- Preserve file formatting when editing JSON and TOML files
- Handle edge cases like networks that exist in one file but not others
- Support deprecating multiple networks in a single command
- Display clear, actionable error messages if something goes wrong
- After completion, verify changes by checking that entries are actually removed
- Automatically run `bun update-whitelist-periphery` after all network removals are complete
- If whitelist update fails, report the error but don't abort (network deprecation is already done)
- After all deprecation steps, search the entire codebase for remaining occurrences of the network name
- Present a concise, organized list of matches grouped by file with line numbers and context
- Ask the user to review and indicate which files/occurrences should be removed
- Some config files (e.g., `config/*.json`) may intentionally keep network values for historical reference - let user decide

## Example Output

```
Deprecating networks: fantom, harmony

✓ Removed 'fantom' from config/networks.json
✓ Removed 'harmony' from config/networks.json
✓ Removed RPC endpoint for 'fantom' from foundry.toml
✓ Removed RPC endpoint for 'harmony' from foundry.toml
✓ Removed etherscan entry for 'fantom' from foundry.toml
✓ Removed etherscan entry for 'harmony' from foundry.toml
✓ Removed 'fantom' from script/deploy/_targetState.json
✓ Removed 'harmony' from script/deploy/_targetState.json
✓ Deleted deployments/fantom.json
✓ Deleted deployments/fantom.diamond.json
✓ Deleted deployments/harmony.json
✓ Deleted deployments/harmony.diamond.json

⚠ Warning: deployments/fantom.staging.json not found (skipped)
⚠ Warning: deployments/harmony.staging.json not found (skipped)

✓ Running bun update-whitelist-periphery...
✓ Whitelist updated successfully

Successfully deprecated 2 networks.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️  MANUAL STEP REQUIRED: Update Product Target Sheet
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Please manually update the Product Target State spreadsheet:
📊 https://docs.google.com/spreadsheets/d/1jX1wfFkSn1s19I_KzMA7vB1kfgGxXUv7kRqwUGJJLF4/edit#gid=0

Actions required:
- Move the "fantom" row to the deprecated section
- Move the "harmony" row to the deprecated section

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Remaining Occurrences Review
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Found additional occurrences of deprecated networks in the codebase:

Network: fantom
  📄 config/whitelist.json
     Line 211: "aurora": [...]
     Line 1880: "fantom": [...]

  📄 config/permit2Proxy.json
     Line 6: "fantom": "0x000000000022D473030F116dDEE9F6B43aC78BA3"

  📄 config/gaszip.json
     Line 9: "fantom": "0x2a37D63EAdFe4b4682a3c28C1c2cD4F109Cc2762"

  📄 script/multiNetworkExecution.sh
     Line 2586: # local NETWORKS=("arbitrum" "aurora" "base" "blast" "bob" "bsc" "cronos" "gravity" "linea" "mainnet" "mantle" "mode" "polygon" "scroll" "taiko")

Network: harmony
  📄 config/whitelist.json
     Line 704: "harmony": [...]

  📄 deployments/harmony.json
     Line 1: { "DiamondCutFacet": "0x..." }

⚠️  Note: Some config files (e.g., config/*.json) may intentionally keep network values for historical reference.

Please review the above list and indicate which files/occurrences should be removed:
- Type the file paths you want to clean up
- Or say "none" if all occurrences should remain
- Or say "all" to remove all occurrences (use with caution)
```
