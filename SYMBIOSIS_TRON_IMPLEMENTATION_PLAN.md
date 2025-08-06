# Symbiosis Facet Tron Deployment Implementation Plan

## Overview

This document provides a comprehensive implementation plan for adding Symbiosis configuration for Tron and creating a combined deployment and registration script for the SymbiosisFacet on the Tron network.

## Task 1: Add Tron Configuration to config/symbiosis.json

### Objective

Add the Tron network configuration to the existing `config/symbiosis.json` file.

### Configuration Data

The SymbiosisFacet deployment script requires only two fields:

- `metaRouter`: The Symbiosis metaRouter address
- `gateway`: The Symbiosis gateway address (provided by team as "metaRouterGateway")

### Implementation Code

```javascript
// Location: config/symbiosis.json
// Add after the last network entry (e.g., after "zksync")
  "zksync": {
    "metaRouter": "0x38307CB291Af47Af9847c134a34E9477c939Ca28",
    "gateway": "0x8cA239448AdD34b057D1CB5934F12AC899DB66e1"
  },
  "tron": {
    "metaRouter": "0x0863786bbf4561f4a2a8be5a9ddf152afd8ae25c",
    "gateway": "0x49e1816a2cf475515e7c80c9f0f0e16ae499198b"
  }
```

### Note on Additional Fields

The Symbiosis team provided additional configuration fields (router, dexFee, bridge, synthesis, portal, fabric, multicallRouter) which are not used by the SymbiosisFacet constructor but may be needed for other purposes. If you need to preserve all fields:

```javascript
  "tron": {
    "metaRouter": "0x0863786bbf4561f4a2a8be5a9ddf152afd8ae25c",
    "gateway": "0x49e1816a2cf475515e7c80c9f0f0e16ae499198b",
    // Additional fields for reference (not used by SymbiosisFacet constructor)
    "router": "0x6E0617948FE030A7E4970F8389D4AD295F249B7E",
    "dexFee": 30,
    "bridge": "0xc5a6517050c44ba78295f57f4754bb68f8705321",
    "synthesis": "0x0000000000000000000000000000000000000000",
    "portal": "0xd83b5752b42856a08087748de6095af0be52d299",
    "fabric": "0x0000000000000000000000000000000000000000",
    "multicallRouter": "0x354ed0e8616678f2829feb2e2e9a0e0869fa82fb"
  }
```

### Validation

- Verify JSON syntax is valid
- Ensure all addresses are in the correct format (0x prefixed)
- Confirm the dexFee value is numeric

## Task 2: Create Combined Deploy and Register Script

### Objective

Create a single TypeScript script that both deploys SymbiosisFacet to Tron and registers it to the Diamond in one operation.

### Script Location

`script/deploy/tron/deploy-and-register-symbiosis-facet.ts`

### Key Features

1. **Combined Operation**: Deploy and register in a single script execution
2. **Constructor Arguments**: SymbiosisFacet requires specific constructor arguments from the config
3. **Automatic Registration**: Register to Diamond immediately after deployment
4. **Environment Support**: Support both staging and production environments
5. **Dry Run Mode**: Include dry run capability for testing both operations
6. **Error Handling**: Comprehensive error handling and logging
7. **Cost Estimation**: Display deployment and registration costs

### Complete Script Code

```typescript
#!/usr/bin/env bun

import { consola } from 'consola'
import { TronWeb } from 'tronweb'
import * as fs from 'fs'
import * as path from 'path'
import { defineCommand, runMain } from 'citty'

import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'
import { TronContractDeployer } from './TronContractDeployer'
import type { ITronDeploymentConfig } from './types'
import {
  loadForgeArtifact,
  logDeployment,
  saveContractAddress,
  getContractVersion,
  getEnvironment,
  getPrivateKey,
  getNetworkConfig,
  getContractAddress,
  ENERGY_PRICE,
} from './utils.js'

/**
 * Get function selectors from contract ABI
 */
function getFunctionSelectors(contractName: string): string[] {
  try {
    const artifactPath = path.join(
      process.cwd(),
      'out',
      `${contractName}.sol`,
      `${contractName}.json`
    )

    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Artifact not found for ${contractName}`)
    }

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'))
    const abi = artifact.abi

    const selectors: string[] = []

    for (const item of abi) {
      if (
        item.type === 'function' &&
        (item.stateMutability === 'nonpayable' ||
          item.stateMutability === 'payable')
      ) {
        // Build function signature
        const signature = `${item.name}(${item.inputs
          .map((i: any) => i.type)
          .join(',')})`

        // Calculate selector (first 4 bytes of keccak256 hash)
        const { keccak256 } = require('ethers')
        const selector = keccak256(Buffer.from(signature)).slice(0, 10)

        selectors.push(selector)
        consola.info(`  Found selector: ${selector} for ${signature}`)
      }
    }

    return selectors
  } catch (error: any) {
    consola.error(`Failed to get selectors for ${contractName}:`, error.message)
    return []
  }
}

/**
 * Estimate energy for diamondCut transaction
 */
async function estimateDiamondCutEnergy(
  tronWeb: any,
  diamondAddress: string,
  facetCuts: any[],
  fullHost: string
): Promise<number> {
  try {
    consola.info('⚡ Estimating energy for diamondCut...')

    const encodedParams = tronWeb.utils.abi.encodeParams(
      ['(address,uint8,bytes4[])[]', 'address', 'bytes'],
      [facetCuts, '0x0000000000000000000000000000000000000000', '0x']
    )

    const functionSelector =
      'diamondCut((address,uint8,bytes4[])[],address,bytes)'
    const apiUrl =
      fullHost.replace(/\/$/, '') + '/wallet/triggerconstantcontract'

    const payload = {
      owner_address: tronWeb.defaultAddress.base58,
      contract_address: diamondAddress,
      function_selector: functionSelector,
      parameter: encodedParams.replace('0x', ''),
      fee_limit: 1000000000,
      call_value: 0,
      visible: true,
    }

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API call failed: ${response.status} - ${errorText}`)
    }

    const result = await response.json()

    if (result.result?.result === false) {
      throw new Error(
        `Energy estimation failed: ${
          result.result?.message || JSON.stringify(result)
        }`
      )
    }

    if (result.energy_used) {
      const safetyMultiplier = 10
      const estimatedEnergy = Math.ceil(result.energy_used * safetyMultiplier)
      consola.info(
        `⚡ Energy estimate: ${result.energy_used} (with ${safetyMultiplier}x safety: ${estimatedEnergy})`
      )
      return estimatedEnergy
    }

    throw new Error('No energy estimation returned')
  } catch (error: any) {
    consola.error('❌ Failed to estimate energy:', error.message)
    throw error
  }
}

/**
 * Register SymbiosisFacet to Diamond
 */
async function registerSymbiosisFacetToDiamond(
  symbiosisFacetAddress: string,
  tronWeb: any,
  fullHost: string,
  dryRun: boolean = false
) {
  try {
    // Load deployment addresses
    const deploymentPath = path.join(process.cwd(), 'deployments', 'tron.json')
    const deployments = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))

    const diamondAddress = deployments.LiFiDiamond
    if (!diamondAddress) {
      throw new Error('LiFiDiamond not found in deployments')
    }

    consola.info(`🔷 LiFiDiamond: ${diamondAddress}`)

    // Load required ABIs
    const diamondCutABI = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'out',
          'DiamondCutFacet.sol',
          'DiamondCutFacet.json'
        ),
        'utf8'
      )
    ).abi

    const diamondLoupeABI = JSON.parse(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'out',
          'DiamondLoupeFacet.sol',
          'DiamondLoupeFacet.json'
        ),
        'utf8'
      )
    ).abi

    const combinedABI = [...diamondCutABI, ...diamondLoupeABI]
    const diamond = tronWeb.contract(combinedABI, diamondAddress)

    // Get function selectors
    consola.info('\n📋 Getting function selectors for SymbiosisFacet...')
    const selectors = getFunctionSelectors('SymbiosisFacet')

    if (selectors.length === 0) {
      throw new Error('No function selectors found for SymbiosisFacet')
    }

    consola.info(`📌 Found ${selectors.length} function selectors`)

    // Check if already registered
    let isRegistered = false
    try {
      const facetsResponse = await diamond.facets().call()
      const currentFacets = Array.isArray(facetsResponse[0])
        ? facetsResponse[0]
        : facetsResponse

      for (const facet of currentFacets) {
        const registeredAddress = tronWeb.address.fromHex(facet[0])
        if (registeredAddress === symbiosisFacetAddress) {
          isRegistered = true
          break
        }
      }
    } catch (e) {
      // If facets() fails, assume not registered
    }

    if (isRegistered) {
      consola.success('✅ SymbiosisFacet is already registered!')
      return
    }

    // Prepare facetCut
    const facetAddressHex = tronWeb.address
      .toHex(symbiosisFacetAddress)
      .replace(/^41/, '0x')
    const facetCuts = [[facetAddressHex, 0, selectors]]

    consola.info('\n📦 Preparing facetCut:')
    consola.info(`   Address: ${symbiosisFacetAddress}`)
    consola.info(`   Action: Add (0)`)
    consola.info(`   Selectors: ${selectors.length}`)

    // Estimate energy
    const estimatedEnergy = await estimateDiamondCutEnergy(
      tronWeb,
      diamondAddress,
      facetCuts,
      fullHost
    )
    const estimatedCost = (estimatedEnergy * ENERGY_PRICE) / 1000000
    consola.info(
      `💰 Estimated registration cost: ${estimatedCost.toFixed(4)} TRX`
    )

    if (dryRun) {
      consola.info('\n📌 Dry run mode - not executing registration')
      consola.info('FacetCut details:', JSON.stringify(facetCuts, null, 2))
      return
    }

    // Check balance
    const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58)
    const balanceTRX = balance / 1000000
    if (balanceTRX < 5) {
      throw new Error(
        `Insufficient balance. Have: ${balanceTRX} TRX, Need: at least 5 TRX`
      )
    }

    // Execute diamondCut
    consola.info(`\n🚀 Executing diamondCut...`)
    const feeLimitInSun = 5_000_000_000 // 5 TRX

    const tx = await diamond
      .diamondCut(facetCuts, '0x0000000000000000000000000000000000000000', '0x')
      .send({
        feeLimit: feeLimitInSun,
        shouldPollResponse: true,
      })

    consola.success(`✅ Registration transaction successful: ${tx}`)

    // Verify registration
    consola.info('\n🔍 Verifying registration...')
    const facetsResponse = await diamond.facets().call()
    const facets = Array.isArray(facetsResponse[0])
      ? facetsResponse[0]
      : facetsResponse

    let found = false
    for (const facet of facets) {
      const facetBase58 = tronWeb.address.fromHex(facet[0])
      if (facetBase58 === symbiosisFacetAddress) {
        found = true
        consola.success(
          `✅ SymbiosisFacet registered successfully with ${facet[1].length} functions`
        )
        break
      }
    }

    if (!found) {
      throw new Error('SymbiosisFacet not found in registered facets')
    }
  } catch (error: any) {
    consola.error('❌ Registration failed:', error.message)
    throw error
  }
}

/**
 * Deploy and register SymbiosisFacet to Tron
 */
async function deployAndRegisterSymbiosisFacet(
  options: { dryRun?: boolean } = {}
) {
  consola.start('TRON SymbiosisFacet Deployment & Registration')
  consola.info('============================================\n')

  // Get environment from config.sh
  const environment = await getEnvironment()

  // Load environment variables
  let verbose = true
  try {
    verbose = getEnvVar('VERBOSE') !== 'false'
  } catch {
    // Use default value
  }

  // Get network configuration
  let tronConfig
  try {
    tronConfig = getNetworkConfig('tron')
  } catch (error: any) {
    consola.error(`❌ ${error.message}`)
    consola.error(
      'Please ensure "tron" network is configured in config/networks.json'
    )
    process.exit(1)
  }

  const network = tronConfig.rpcUrl

  // Get the correct private key based on environment
  let privateKey: string
  try {
    privateKey = await getPrivateKey()
  } catch (error: any) {
    consola.error(`❌ ${error.message}`)
    consola.error(
      `Please ensure ${
        environment === 'production' ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY'
      } is set in your .env file`
    )
    process.exit(1)
  }

  // Load Symbiosis configuration
  const symbiosisConfigPath = path.join(
    process.cwd(),
    'config',
    'symbiosis.json'
  )
  if (!fs.existsSync(symbiosisConfigPath)) {
    consola.error('❌ config/symbiosis.json not found')
    process.exit(1)
  }

  const symbiosisConfig = JSON.parse(
    fs.readFileSync(symbiosisConfigPath, 'utf8')
  )
  const tronSymbiosisConfig = symbiosisConfig.tron

  if (!tronSymbiosisConfig) {
    consola.error('❌ Tron configuration not found in symbiosis.json')
    process.exit(1)
  }

  // Validate required addresses
  if (!tronSymbiosisConfig.metaRouter || !tronSymbiosisConfig.gateway) {
    consola.error('❌ Missing required addresses in Tron Symbiosis config')
    consola.error('Required: metaRouter and gateway')
    process.exit(1)
  }

  // Initialize deployer
  const config: ITronDeploymentConfig = {
    fullHost: network,
    privateKey,
    verbose,
    dryRun: options.dryRun || false,
    safetyMargin: 1.5,
    maxRetries: 3,
    confirmationTimeout: 120000,
  }

  const deployer = new TronContractDeployer(config)

  // Initialize TronWeb for address conversion and Diamond interaction
  const tronWeb = new TronWeb({
    fullHost: network,
    privateKey,
  })

  try {
    // Get network info
    const networkInfo = await deployer.getNetworkInfo()
    consola.info('📍 Network Info:', {
      network: network.includes('shasta') ? 'Shasta Testnet' : 'Mainnet',
      rpcUrl: network,
      environment: environment.toUpperCase(),
      address: networkInfo.address,
      balance: `${networkInfo.balance} TRX`,
      block: networkInfo.block,
    })

    if (networkInfo.balance < 10) {
      consola.warn('⚠️  Low balance detected. Deployment may fail.')
    }

    consola.info('\n📋 Deployment & Registration Plan:')
    consola.info('1. Deploy SymbiosisFacet with constructor arguments')
    consola.info('   - metaRouter:', tronSymbiosisConfig.metaRouter)
    consola.info('   - gateway:', tronSymbiosisConfig.gateway)
    consola.info('2. Register SymbiosisFacet to LiFiDiamond')
    consola.info('   - Add facet with function selectors')
    consola.info('   - Verify registration')

    if (!options.dryRun && environment === 'production') {
      consola.warn(
        '⚠️  WARNING: This will deploy and register SymbiosisFacet to Tron mainnet in PRODUCTION!'
      )
      const shouldContinue = await consola.prompt('Do you want to continue?', {
        type: 'confirm',
        initial: false,
      })

      if (!shouldContinue) {
        consola.info('Deployment cancelled')
        process.exit(0)
      }
    } else if (!options.dryRun) {
      consola.warn(
        '⚠️  This will deploy and register SymbiosisFacet to Tron mainnet in STAGING!'
      )
      const shouldContinue = await consola.prompt('Do you want to continue?', {
        type: 'confirm',
        initial: true,
      })

      if (!shouldContinue) {
        consola.info('Deployment cancelled')
        process.exit(0)
      }
    }

    // STEP 1: DEPLOY SYMBIOSISFACET
    consola.info('\n=== STEP 1: Deploy SymbiosisFacet ===')

    let symbiosisFacetAddress: string
    let deploymentCost = 0

    // Check if already deployed
    const existingAddress = await getContractAddress('tron', 'SymbiosisFacet')
    if (existingAddress && !options.dryRun) {
      consola.warn(
        `⚠️  SymbiosisFacet is already deployed at: ${existingAddress}`
      )
      const shouldRedeploy = await consola.prompt('Redeploy SymbiosisFacet?', {
        type: 'confirm',
        initial: false,
      })

      if (!shouldRedeploy) {
        consola.info(`✅ Using existing SymbiosisFacet at: ${existingAddress}`)
        symbiosisFacetAddress = existingAddress
      } else {
        // Deploy new instance
        const deployResult = await deploySymbiosisFacet()
        symbiosisFacetAddress = deployResult.address
        deploymentCost = deployResult.cost
      }
    } else {
      // Deploy new instance
      const deployResult = await deploySymbiosisFacet()
      symbiosisFacetAddress = deployResult.address
      deploymentCost = deployResult.cost
    }

    // STEP 2: REGISTER TO DIAMOND
    consola.info('\n=== STEP 2: Register to Diamond ===')
    await registerSymbiosisFacetToDiamond(
      symbiosisFacetAddress,
      tronWeb,
      network,
      options.dryRun
    )

    // Print final summary
    consola.success('\n✨ Deployment & Registration Complete!')
    consola.info('=====================================\n')
    consola.info('Contract: SymbiosisFacet')
    consola.info(`Address: ${symbiosisFacetAddress}`)
    consola.info(`Environment: ${environment.toUpperCase()}`)
    if (deploymentCost > 0) {
      consola.info(`Deployment Cost: ${deploymentCost.toFixed(4)} TRX`)
    }
    consola.info('Status: Deployed and Registered to Diamond')

    if (options.dryRun) {
      consola.info(
        '\n📌 This was a DRY RUN - no actual deployment or registration occurred'
      )
    }

    // Helper function to deploy SymbiosisFacet
    async function deploySymbiosisFacet(): Promise<{
      address: string
      cost: number
    }> {
      // Load artifact
      const artifact = await loadForgeArtifact('SymbiosisFacet')

      // Get version
      const version = await getContractVersion('SymbiosisFacet')
      consola.info(`📌 Version: ${version}`)

      // Prepare constructor arguments
      const metaRouterHex = tronSymbiosisConfig.metaRouter
      const gatewayHex = tronSymbiosisConfig.gateway

      // For display purposes - show Tron base58 format
      const metaRouterTron = tronWeb.address.fromHex(
        metaRouterHex.replace('0x', '41')
      )
      const gatewayTron = tronWeb.address.fromHex(
        gatewayHex.replace('0x', '41')
      )

      consola.info(`🔧 Constructor Arguments:`)
      consola.info(`   metaRouter: ${metaRouterTron} (hex: ${metaRouterHex})`)
      consola.info(`   gateway: ${gatewayTron} (hex: ${gatewayHex})`)

      // Use original hex format (0x...) for constructor args
      const constructorArgs = [metaRouterHex, gatewayHex]

      // Deploy contract
      consola.info('\n🚀 Deploying SymbiosisFacet...')
      const result = await deployer.deployContract(artifact, constructorArgs)

      consola.success(
        `✅ SymbiosisFacet deployed to: ${result.contractAddress}`
      )
      consola.info(`📝 Transaction: ${result.transactionId}`)
      consola.info(`💰 Cost: ${result.actualCost.trxCost} TRX`)

      // Save deployment info (skip in dry run)
      if (!options.dryRun) {
        // Encode constructor args as hex
        const abiCoder = new (await import('ethers')).AbiCoder()
        const constructorArgsHex = abiCoder.encode(
          ['address', 'address'],
          constructorArgs
        )

        await logDeployment(
          'SymbiosisFacet',
          'tron',
          result.contractAddress,
          version,
          constructorArgsHex,
          false
        )

        await saveContractAddress(
          'tron',
          'SymbiosisFacet',
          result.contractAddress
        )
        consola.success('💾 Deployment info saved')
      }

      return {
        address: result.contractAddress,
        cost: result.actualCost.trxCost,
      }
    }
  } catch (error: any) {
    consola.error('❌ Deployment failed:', error.message)
    process.exit(1)
  }
}

// CLI handling
const main = defineCommand({
  meta: {
    name: 'deploy-and-register-symbiosis-facet',
    description:
      'Deploy and register SymbiosisFacet to the Tron Diamond contract',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Run in dry-run mode without sending transactions',
      default: false,
    },
  },
  async run({ args }) {
    const options = {
      dryRun: args.dryRun,
    }

    if (args.dryRun) {
      consola.info('🏃 Running in DRY RUN mode - no transactions will be sent')
    }

    try {
      await deployAndRegisterSymbiosisFacet(options)
      process.exit(0)
    } catch (error) {
      consola.error(
        '❌ Failed:',
        error instanceof Error ? error.message : error
      )
      process.exit(1)
    }
  },
})

if (import.meta.main) {
  runMain(main)
}

export { deployAndRegisterSymbiosisFacet }
```

### Key Implementation Details

1. **Combined Operation**: The script handles both deployment and registration in a single execution
2. **Reuse Detection**: Checks if SymbiosisFacet is already deployed and offers to reuse it
3. **Auto-detect Selectors**: Automatically extracts function selectors from contract ABI
4. **Energy Estimation**: Estimates energy costs for both deployment and registration
5. **Error Recovery**: Comprehensive error handling with clear messages
6. **Dry Run Support**: Test the entire flow without executing transactions

## Task 3: Deployment Process Flow

### Prerequisites

1. Ensure SymbiosisFacet contract exists in `src/Facets/`
2. Compile contracts with `forge build`
3. Set up environment variables (PRIVATE_KEY or PRIVATE_KEY_PRODUCTION)
4. Ensure sufficient TRX balance (minimum 10 TRX recommended)

### Deployment Steps

1. **Single Command Deployment**:

   ```bash
   bunx tsx script/deploy/tron/deploy-and-register-symbiosis-facet.ts
   ```

2. **Dry Run Testing**:

   ```bash
   bunx tsx script/deploy/tron/deploy-and-register-symbiosis-facet.ts --dry-run
   ```

3. **Verify Deployment**:
   - Check `deployments/tron.json` for SymbiosisFacet address
   - Verify facet is registered by checking Diamond facets

### Environment Variables

- `ENVIRONMENT`: Set to "staging" or "production"
- `PRIVATE_KEY`: Private key for staging deployments
- `PRIVATE_KEY_PRODUCTION`: Private key for production deployments
- `VERBOSE`: Set to "true" for detailed logging

### Example Environment Setup (.env file)

```bash
# For staging deployment
ENVIRONMENT=staging
PRIVATE_KEY=your_staging_private_key_here
VERBOSE=true

# For production deployment
# ENVIRONMENT=production
# PRIVATE_KEY_PRODUCTION=your_production_private_key_here
```

### Example config.sh Setup

```bash
#!/bin/bash
# Location: config.sh

# Set environment (staging or production)
export ENVIRONMENT="staging"

# Other configurations...
```

## Task 4: Error Handling and Edge Cases

### Common Issues and Solutions

1. **Insufficient Balance**: Ensure at least 10 TRX in deployer wallet
2. **Energy Estimation Failure**: Retry with higher safety margin
3. **Registration Failure**: Check if facet already registered
4. **Address Format Issues**: Ensure proper conversion between Ethereum and Tron formats

### Validation Steps

1. Verify Symbiosis config addresses are valid
2. Check contract compilation before deployment
3. Ensure Diamond contract exists and is accessible
4. Validate function selectors match the contract ABI

## Task 5: Testing Strategy

### Dry Run Testing

1. Run script with `--dry-run` flag
2. Verify constructor arguments are correct
3. Check energy estimation without spending TRX

### Staging Deployment

1. Deploy to Tron mainnet with staging configuration
2. Test basic functionality
3. Verify registration and function calls

### Production Deployment

1. Review all configurations
2. Ensure multisig approval if required
3. Deploy with production private key
4. Monitor transaction success

## Implementation Notes

### Address Format Conversion

- Ethereum format: `0x...` (40 hex chars)
- Tron hex format: `41...` (42 hex chars)
- Tron base58 format: `T...` (34 chars)

### Address Conversion Code Examples

```typescript
// Convert Ethereum address to Tron base58
const ethAddress = '0x6E0617948FE030A7E4970F8389D4AD295F249B7E'
const tronHex = ethAddress.replace('0x', '41')
const tronBase58 = tronWeb.address.fromHex(tronHex)
// Result: "TKL9ztBKiUyqRsDxQVz8FqYDTdW4wWUAGo" (example)

// Convert Tron base58 to hex for ABI encoding
const tronAddress = 'TKL9ztBKiUyqRsDxQVz8FqYDTdW4wWUAGo'
const hexAddress = '0x' + tronWeb.address.toHex(tronAddress).substring(2)
// Result: "0x6E0617948FE030A7E4970F8389D4AD295F249B7E"
```

### Constructor Encoding Example

```typescript
// For SymbiosisFacet constructor
const metaRouter = '0x0863786bbf4561f4a2a8be5a9ddf152afd8ae25c'
const gateway = '0x49e1816a2cf475515e7c80c9f0f0e16ae499198b'

// Constructor args use hex format (0x...)
const constructorArgs = [metaRouter, gateway]

// For ABI encoding (if needed separately)
const abiCoder = new ethers.AbiCoder()
const encoded = abiCoder.encode(['address', 'address'], constructorArgs)
```

### Function Selector Calculation Example

```typescript
// Calculate function selector from signature
const { keccak256 } = require('ethers')

// Example function signature
const signature =
  'startBridgeTokensViaSymbiosis((bytes32,string,address,address,uint256,uint256,bool,bool),bytes)'

// Calculate selector (first 4 bytes of keccak256)
const hash = keccak256(Buffer.from(signature))
const selector = hash.slice(0, 10) // "0x" + 8 hex chars
// Result: "0x12345678" (example)
```

### Gas/Energy Considerations

- SymbiosisFacet deployment: ~500-1000 energy units
- Registration to Diamond: ~3000-5000 energy units
- Always use safety margin (1.5x to 2x)

### File Updates Required

1. `config/symbiosis.json`: Add Tron configuration
2. `script/deploy/tron/deploy-and-register-symbiosis-facet.ts`: New combined script
3. `deployments/tron.json`: Will be updated automatically
4. `deployments/_deployments_log_file.json`: Will be updated automatically

## Success Criteria

1. SymbiosisFacet successfully deployed to Tron
2. Contract address saved in deployment files
3. Facet registered to LiFiDiamond
4. All functions accessible through Diamond proxy
5. Deployment costs within expected range
6. No errors or reverts during process

## Post-Deployment Verification

1. Call `diamond.facets()` to verify registration
2. Test a view function through the diamond
3. Verify contract on Tronscan (if applicable)
4. Update documentation with deployment details
5. Notify team of successful deployment

This implementation plan provides clear, unambiguous instructions for an AI coding agent to implement the Symbiosis Tron deployment without requiring additional context or clarification.
