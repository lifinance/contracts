# Multi Network Execution System

This document explains how to use the complete network execution system in `multiNetworkExecution.sh`, which includes all network iteration functionality, automatic grouping, and progress tracking.

## Overview

The `multiNetworkExecution.sh` file contains the complete network execution system, including:

- **Original Functions**: `iterateAllNetworks()`, `handleNetwork()`, `generateSummary()`, etc.
- **New Grouping Functions**: Automatic network grouping by EVM version and zkEVM status
- **Progress Tracking**: Resumable execution with detailed progress tracking
- **Build Selection**: Each group builds under its own foundry profile (`FOUNDRY_PROFILE`), so `foundry.toml` is never modified

The system automatically groups networks by their EVM version and zkEVM status, then executes them in the correct order:

1. **Group 1: Cancun EVM** (solc 0.8.29) - Networks like blast, hyperevm, berachain (executed first)
2. **Group 2: zkEVM Networks** (use profile.zksync) - Networks like zksync, polygonzkevm
3. **Group 3: London EVM** (solc 0.8.17) - Networks like mainnet, arbitrum, base

**Important Note**: The solc version is derived from `targetEvmVersion` in `networks.json` — there is no separate solc field to configure:

- Cancun EVM networks → solc 0.8.29 via `[profile.default]` (executed first)
- London EVM networks → solc 0.8.17 via `[profile.solc_floor]`
- zkEVM networks → use existing profile.zksync
  - Deploy scripts automatically use the zksync profile for zkEVM networks
  - zkEVM networks always execute sequentially for proper resource management

## Key Features

- **Automatic Grouping**: Networks are automatically categorized based on their configuration in `networks.json`
- **Sequential Group Execution**: Groups are executed one after another (cannot run in parallel because they share one `out/` artifact tree)
- **Parallel Network Execution**: Within each group, networks can run in parallel
- **Progress Tracking**: Tracks which networks succeeded, failed, or are still pending
- **Resumable Execution**: Simply run the same command again to retry only failed networks
- **Profile Selection**: Exports `FOUNDRY_PROFILE` per group before building; nothing in the checkout is rewritten
- **Comprehensive Logging**: Detailed logging with timestamps and error reporting

## Configuration

The system is configured at the top of `multiNetworkExecution.sh` in three main sections:

### 1. Execution Configuration (Lines 27-37)

Configure execution behavior:

```bash
# PARALLEL EXECUTION SETTINGS
# Set to true to run networks in parallel within each group, false for sequential execution
RUN_PARALLEL=true

# zkEVM networks always run sequentially (regardless of RUN_PARALLEL setting)
# This is because zkEVM networks require special handling in deploy scripts
ZKEVM_ALWAYS_SEQUENTIAL=true
```

### 2. Network Selection Configuration (Lines 39-55)

Choose which networks to execute:

```bash
# Option 1: Use all included networks (default)
NETWORKS=($(getIncludedNetworksArray))

# Option 2: Use specific networks
# NETWORKS=("mainnet" "arbitrum" "base" "zksync" "blast" "hyperevm")

# Option 3: Use networks by EVM version
# NETWORKS=($(getIncludedNetworksByEvmVersionArray "london"))
```

### 3. Network Action Configuration (Lines 57-82)

Choose what actions to execute per network:

```bash
# DEPLOY - Deploy the contract to the network
# deployContract "$NETWORK" "$ENVIRONMENT" "$CONTRACT"

# VERIFY - Verify the contract on the network
# getContractVerified "$NETWORK" "$ENVIRONMENT" "$CONTRACT"

# PROPOSE - Create multisig proposal for the contract
# createMultisigProposalForContract "$NETWORK" "$ENVIRONMENT" "$CONTRACT" "$LOG_DIR"
```

### How Error Tracking Works:

1. **Simple Approach**: The function returns the exit code of the last executed command
2. **Network Status**:
   - `0` = Last action succeeded
   - `1` = Last action failed
3. **Progress Tracking**: Failed networks are tracked in the progress file and can be retried
4. **Retry Logic**: Simply run the same command again to retry only failed networks

**Note**: If you need more sophisticated error handling (e.g., continue on some failures), you can add custom logic in the `executeNetworkActions` function.

## Usage Examples

### 1. Drop-in Replacement for iterateAllNetworks (RECOMMENDED)

```bash
# In playground.sh, replace this:
# iterateAllNetworks "$CONTRACT" "$ENVIRONMENT"

# With this:
iterateAllNetworksGrouped "$CONTRACT" "$ENVIRONMENT"
```

**To configure which networks to execute:**
Edit the `NETWORKS` array in the **NETWORK SELECTION CONFIGURATION** section at the top of `multiNetworkExecution.sh` (around line 35).

**To configure what actions to execute per network:**
Edit the **NETWORK ACTION CONFIGURATION** section at the top of `multiNetworkExecution.sh` (around line 56). Uncomment the actions you want to execute.

This is the **easiest way** to use the new system. It:

- Uses your existing `handleNetwork` function
- Automatically groups networks by EVM version
- Selects the foundry profile per group and recompiles
- Provides progress tracking and resumable execution
- Maintains the same interface as your existing code

### 2. Execute Specific Networks with Automatic Grouping

```bash
# In playground.sh, uncomment and modify:
local NETWORKS=("mainnet" "arbitrum" "base" "zksync" "blast" "hyperevm")
executeNetworksByGroup "$CONTRACT" "$ENVIRONMENT" "${NETWORKS[@]}"
```

### 3. Execute All Networks for a Contract

```bash
executeAllNetworksForContract "$CONTRACT" "$ENVIRONMENT"
```

### 4. Execute Only Networks with Specific EVM Version

```bash
# Execute only London EVM networks
executeNetworksByEvmVersion "$CONTRACT" "$ENVIRONMENT" "london"

# Execute only Cancun EVM networks
executeNetworksByEvmVersion "$CONTRACT" "$ENVIRONMENT" "cancun"
```

### 5. Retry Failed Networks

```bash
# Simply run the same command again!
# The system automatically handles retries by resuming from existing progress
iterateAllNetworksGrouped "$CONTRACT" "$ENVIRONMENT"
```

### 6. Get Network Grouping Information

```bash
local NETWORKS=("mainnet" "arbitrum" "base" "zksync" "blast" "hyperevm")
groupNetworksByExecutionGroup "${NETWORKS[@]}"
```

## How It Works

### 1. Network Grouping

The system reads `networks.json` to determine:

- `isZkEVM`: true/false (determines if it's a zkEVM network)
- `targetEvmVersion`: "london" or "cancun" (determines the compilation group)

**Note**: The solc version is derived from `targetEvmVersion` — there is no separate solc field:

- London EVM → solc 0.8.17 via `[profile.solc_floor]`
- Cancun EVM → solc 0.8.29 via `[profile.default]`
- zkEVM networks (`isZkEVM: true`) → zksolc via `[profile.zksync]`

### 2. Execution Flow

1. **Group 1 (Cancun)**: Clear `FOUNDRY_PROFILE` → Recompile → Execute networks in parallel
2. **Group 2 (zkEVM)**: Execute networks sequentially (zkEVM compilation handled by deploy scripts)
3. **Group 3 (London)**: Export `FOUNDRY_PROFILE=solc_floor` → Recompile → Execute networks in parallel
4. **Show summary** of results

### 3. Progress Tracking

- Creates `.network_execution_progress.json` to track progress
- Each network has status: `pending`, `in_progress`, `success`, or `failed`
- Failed networks can be retried without redoing successful ones
- Progress file is cleaned up on successful completion

### 4. Error Handling

- Retry logic for individual network failures
- Graceful handling of interrupts (Ctrl+C)
- Detailed error messages and logging
- Automatic cleanup on exit

## Configuration

### Networks.json Requirements

Each network must have these properties:

```json
{
  "network_name": {
    "isZkEVM": false,
    "targetEvmVersion": "london"
  }
}
```

**Note**: The solc version is derived from `targetEvmVersion` — there is no separate solc-version field to set:

- `"targetEvmVersion": "london"` → uses solc 0.8.17
- `"targetEvmVersion": "cancun"` → uses solc 0.8.29
- `"isZkEVM": true` → uses the zksolc compiler via [profile.zksync]; no recompilation needed here

### Foundry.toml Profiles

The system expects these profiles in `foundry.toml`:

- `[profile.default]` - Cancun networks
- `[profile.solc_floor]` - London networks (solc 0.8.17 / evm london, everything else inherited from default)
- `[profile.zksync]` - zkEVM networks

## Integration with Existing Code

The new system integrates with existing functions:

- Uses `handleNetwork()` from the original `iterateAllNetworks()` function
- Compatible with existing deployment and verification functions
- Maintains the same logging and error handling patterns

## Example Output

```
[2024-01-15 10:30:00] Starting network execution for GlacisFacet in production
[2024-01-15 10:30:00] Networks to process: mainnet arbitrum base zksync blast hyperevm
[2024-01-15 10:30:00] Group: cancun (2 networks): blast hyperevm
[2024-01-15 10:30:00] Running forge build for Cancun EVM group...
[2024-01-15 10:30:05] [blast] 🔄 IN PROGRESS: Operation started
[2024-01-15 10:30:05] [hyperevm] 🔄 IN PROGRESS: Operation started
[2024-01-15 10:30:15] [blast] ✅ SUCCESS: Operation completed successfully
[2024-01-15 10:30:16] [hyperevm] ✅ SUCCESS: Operation completed successfully
[2024-01-15 10:30:17] Group cancun execution completed. Failed networks: 0
[2024-01-15 10:30:17] Group: zkevm (1 networks): zksync
[2024-01-15 10:30:25] [zksync] 🔄 IN PROGRESS: Operation started
[2024-01-15 10:30:35] [zksync] ✅ SUCCESS: Operation completed successfully
[2024-01-15 10:30:35] Group zkevm execution completed. Failed networks: 0
[2024-01-15 10:30:35] Group: london (3 networks): mainnet arbitrum base
[2024-01-15 10:30:35] Running forge build for London EVM group (FOUNDRY_PROFILE=solc_floor)...
[2024-01-15 10:30:40] [mainnet] 🔄 IN PROGRESS: Operation started
[2024-01-15 10:30:40] [arbitrum] 🔄 IN PROGRESS: Operation started
[2024-01-15 10:30:40] [base] 🔄 IN PROGRESS: Operation started
[2024-01-15 10:30:50] [mainnet] ✅ SUCCESS: Operation completed successfully
[2024-01-15 10:30:51] [arbitrum] ✅ SUCCESS: Operation completed successfully
[2024-01-15 10:30:52] [base] ✅ SUCCESS: Operation completed successfully
[2024-01-15 10:30:52] Group london execution completed. Failed networks: 0
[2024-01-15 10:30:52] All network executions completed successfully!
```

## Troubleshooting

### Common Issues

1. **"Network not found in networks.json"**

   - Ensure the network name matches exactly what's in `networks.json`
   - Check that the network has the required properties

2. **"Failed to prepare the build for group ..."**

   - Ensure `foundry.toml` declares the group's profile (`[profile.solc_floor]` for london)
   - Check that the file exists and is not corrupted

3. **"Failed to compile contracts"**

   - Ensure the group's profile in `foundry.toml` pins the correct solc version
   - Check that all dependencies are properly installed

4. **"Progress tracking file not found"**
   - This happens when trying to retry without a previous execution
   - Run the full execution first, then retry if needed

### Recovery

If execution is interrupted or has failures:

1. The progress file `.network_execution_progress.json` will remain
2. **Simply run the same command again** to resume from where it left off
3. Only pending and failed networks will be retried
4. Successful networks will be skipped automatically
5. No need for special retry functions - just use the same command!

## Complete System Migration

All network execution functionality is now consolidated in `multiNetworkExecution.sh`:

### **What's Included:**

1. **Original Functions** (moved from `playground.sh`):

   - `iterateAllNetworks()` - Original network iteration function
   - `handleNetwork()` - Your custom network handling logic
   - `generateSummary()` - Execution summary generation
   - `cleanupStaleLocks()` - Lock file cleanup

2. **New Grouping Functions**:
   - `iterateAllNetworksGrouped()` - Drop-in replacement with automatic grouping
   - `executeNetworksByGroup()` - Execute specific network groups
   - `groupNetworksByExecutionGroup()` - Group networks by EVM version
   - Progress tracking and resumable execution

### **Migration Steps:**

1. **Source the helpers file** in your script:

   ```bash
   source script/multiNetworkExecution.sh
   ```

2. **Replace function calls**:

   ```bash
   # Old way (still works)
   iterateAllNetworks "$CONTRACT" "$ENVIRONMENT"

   # New way (with automatic grouping)
   iterateAllNetworksGrouped "$CONTRACT" "$ENVIRONMENT"
   ```

3. **Keep your existing `handleNetwork` function** - it will be used automatically

4. **Enjoy the benefits**:
   - Automatic grouping by EVM version
   - Per-group build profile selection
   - Progress tracking and resumable execution
   - Better error handling and logging
   - All functionality in one shareable file
