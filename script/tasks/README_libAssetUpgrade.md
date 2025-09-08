# LibAsset v2.0.0 Upgrade Script

This script handles the upgrade of contracts to use LibAsset v2.0.0, which was introduced in commit `b7d63f78d87603b97ab300dc2526f9a1dbee2917` on May 6, 2025.

## Overview

The LibAsset v2.0.0 upgrade process includes:

1. **Contract Identification**: Identifies all contracts that use LibAsset
2. **Deployment Date Filtering**: Filters contracts deployed after LibAsset v2.0.0 was introduced
3. **Contract Redeployment**: Redeploys identified contracts with verification
4. **Diamond Cut Generation**: Creates calldata for updating diamond facets
5. **Periphery Registry Updates**: Generates calldata for updating periphery contracts
6. **Outdated Facet Removal**: Identifies facets that can be removed
7. **Multisig Proposal Creation**: Creates proposals for the upgrades

## Usage

### Single Network Upgrade

```bash
# Dry run mode (recommended first)
libAssetUpgrade "mainnet" "production"

# Actual execution
DRY_RUN_MODE=false libAssetUpgrade "mainnet" "production"
```

### Multiple Networks Upgrade

```bash
# Dry run mode
libAssetUpgradeAllNetworks "production" "mainnet" "arbitrum" "base" "polygon"

# Actual execution
DRY_RUN_MODE=false libAssetUpgradeAllNetworks "production" "mainnet" "arbitrum" "base" "polygon"
```

### Direct Script Execution

```bash
# Single network
./script/tasks/libAssetUpgrade.sh mainnet production true

# Multiple networks
./script/tasks/libAssetUpgrade.sh --all-networks production true mainnet arbitrum base
```

## Configuration

### Environment Variables

- `DRY_RUN_MODE`: Set to `true` for testing without making changes (default: `true`)
- `LIBASSET_V2_COMMIT_DATE`: Date when LibAsset v2.0.0 was introduced (default: "2025-05-06")
- `LIBASSET_V2_COMMIT_HASH`: Commit hash for LibAsset v2.0.0 (default: "b7d63f78d87603b97ab300dc2526f9a1dbee2917")

### Network Configuration

The script uses the existing network configuration from:

- `./deployments/{NETWORK}.{ENVIRONMENT}.json` - Contract addresses
- `./config/networks.json` - Network settings
- `./target_vs_deployed_production.txt` - Target state

## Output Files

The script generates several output files in `/tmp/`:

1. **`diamond_cut_calldata_{NETWORK}_{ENVIRONMENT}.txt`**

   - Contains diamond cut calldata for facet updates
   - Includes function selector analysis
   - Shows added/removed selectors

2. **`periphery_registry_calldata_{NETWORK}_{ENVIRONMENT}.txt`**

   - Contains calldata for updating periphery contracts
   - Individual calldata for each contract
   - Combined calldata for batching

3. **`outdated_facets_{NETWORK}_{ENVIRONMENT}.txt`**
   - Lists facets that can be removed
   - Shows contract names and addresses
   - Requires manual review before removal

## Safety Features

### Dry Run Mode

The script runs in dry run mode by default, which:

- Identifies contracts that need upgrading
- Shows what would be redeployed
- Generates calldata files for review
- Does not make any actual changes

### Function Selector Analysis

The script analyzes function selectors to:

- Identify which functions are being added/removed
- Show which contracts own which selectors
- Help with manual review of changes

### Comprehensive Logging

The script provides detailed logging:

- Progress for each step
- Warnings for potential issues
- Summary of results
- Error handling with clear messages

## Integration with Playground

The script is integrated with `playground.sh`:

```bash
# In playground.sh, uncomment these lines:
# libAssetUpgrade "$NETWORK" "$ENVIRONMENT"
# libAssetUpgradeAllNetworks "$ENVIRONMENT" "mainnet" "arbitrum" "base" "polygon"
```

## Prerequisites

- Bash shell
- `jq` for JSON processing
- `cast` for Ethereum interactions
- `bunx` for TypeScript execution
- Access to deployment logs and network configurations

## Error Handling

The script includes comprehensive error handling:

- Validates input parameters
- Checks for required files and dependencies
- Handles network connectivity issues
- Provides clear error messages
- Continues processing other networks if one fails

## Examples

### Example 1: Single Network Dry Run

```bash
# Set network and environment in playground.sh
NETWORK="mainnet"
ENVIRONMENT="production"

# Run the upgrade
libAssetUpgrade "$NETWORK" "$ENVIRONMENT"
```

### Example 2: Multiple Networks with Specific List

```bash
# Upgrade specific networks
libAssetUpgradeAllNetworks "production" "mainnet" "arbitrum" "base" "polygon"
```

### Example 3: All Networks

```bash
# Upgrade all included networks
libAssetUpgradeAllNetworks "production"
```

## Troubleshooting

### Common Issues

1. **No contracts found**: Check if contracts are deployed on the network
2. **Deployment date issues**: Verify the commit date is correct
3. **Function selector errors**: Ensure ABI files are available
4. **Network connectivity**: Check RPC URLs and network access

### Debug Mode

Enable debug mode by setting:

```bash
export DEBUG=true
```

### Manual Review

Always review the generated calldata files before creating proposals:

- Check function selectors
- Verify contract addresses
- Review outdated facets list
- Test calldata in a test environment

## Security Considerations

- Always run in dry run mode first
- Review all generated calldata
- Test on testnets before mainnet
- Verify contract addresses and function selectors
- Use multisig for production deployments

## Support

For issues or questions:

1. Check the generated log files
2. Review the error messages
3. Verify network connectivity
4. Check contract deployment status
5. Consult the existing deployment scripts for reference

