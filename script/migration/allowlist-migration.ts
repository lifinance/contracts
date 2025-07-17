#!/usr/bin/env bun

/**
 * Allow List Migration Script
 *
 * This script performs a complete migration of the allow list configuration. Since there's
 * no way to clear mappings on-chain, we need to explicitly remove all previously approved
 * selectors and set the new desired state. The process works as follows:
 *
 * 1. Loads all historically approved selectors from flattened-selectors.json
 *    These selectors were previously scanned from on-chain events and represent
 *    the complete set of selectors that need to be removed to clear the old state
 *
 * 2. Loads the desired new state from two config files:
 *    - whitelistedAddresses.json: Contains contract addresses that should be
 *      whitelisted after migration for each network
 *    - whitelistedSelectors.json: Contains function selectors that should be
 *      whitelisted after migration
 *
 * 3. Reads chain-specific configurations from prepareFunctionSelectorsConfig.json:
 *    - Custom RPC endpoints for more reliable event scanning
 *    - Chain-specific event chunk sizes to handle RPC limitations
 *    - Other network-specific scanning parameters
 *
 * 4. Executes the migration by calling the migrate function with:
 *    - All historical selectors to remove (from step 1)
 *    - New addresses to whitelist (from step 2)
 *    - New selectors to whitelist (from step 2)
 */

import 'dotenv/config'

import { existsSync, readFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import networksData from '../../config/networks.json'
import whitelistedAddresses from '../../config/whitelistedAddresses.json'
import whitelistedSelectors from '../../config/whitelistedSelectors.json'
import { EnvironmentEnum, type SupportedChain } from '../common/types'
import { getDeployments } from '../utils/deploymentHelpers'

// Define interfaces
interface INetworkConfig {
  name: SupportedChain
  chainId: number
  rpcUrl: string
  status: string
}

interface IDeploymentData {
  LiFiDiamond?: string
  [key: string]: string | undefined
}

interface IWhitelistedSelectors {
  selectors: string[]
}
// WhitelistManagerFacet ABI for events and migration function
const WHITELIST_MANAGER_ABI = parseAbi([
  'function migrate(bytes4[] calldata selectorsToRemove, address[] calldata contractsToAdd, bytes4[] calldata selectorsToAdd) external',
  'function isMigrated() external view returns (bool)',
])

// Define the command
const cmd = defineCommand({
  meta: {
    name: 'allowlist-migration',
    description:
      'Migrate allow list configuration from events to current config',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network to migrate (required)',
      required: true,
    },
    privateKey: {
      type: 'string',
      description: 'Private key to use for signing transactions',
      required: false,
    },
    dryRun: {
      type: 'boolean',
      description: 'Simulate migration without sending transactions',
      required: false,
      default: false,
    },
    rpcUrl: {
      type: 'string',
      description: 'Override RPC URL for the network',
      required: false,
    },
    environment: {
      type: 'string',
      description: 'Environment to use (staging or production)',
      required: false,
      default: EnvironmentEnum[EnvironmentEnum.production],
      options: [
        EnvironmentEnum[EnvironmentEnum.staging],
        EnvironmentEnum[EnvironmentEnum.production],
      ],
    },
  },
  async run({ args }) {
    const privateKey = args?.privateKey || process.env.PRIVATE_KEY_PRODUCTION
    const isDryRun = Boolean(args?.dryRun)
    const rpcUrlOverride = args?.rpcUrl
    const environment =
      args?.environment === EnvironmentEnum[EnvironmentEnum.staging]
        ? EnvironmentEnum.staging
        : EnvironmentEnum.production

    if (!privateKey) {
      consola.error(
        'No private key provided. Use --privateKey or set PRIVATE_KEY_PRODUCTION environment variable.'
      )
      process.exit(1)
    }

    if (!args.network) {
      consola.error('Network is required. Use --network <network_name>')
      process.exit(1)
    }

    const networkName = args.network.toLowerCase()
    const networkConfig = (networksData as Record<string, INetworkConfig>)[
      networkName
    ]

    if (!networkConfig) {
      consola.error(`Network '${args.network}' not found in configuration`)
      process.exit(1)
    }

    if (isDryRun)
      consola.info('🔍 Running in DRY RUN mode - no transactions will be sent')

    consola.info(
      `🔍 Processing network: ${networkConfig.name} (Chain ID: ${networkConfig.chainId})`
    )

    await migrateAllowList(
      networkConfig,
      privateKey,
      isDryRun,
      rpcUrlOverride,
      environment
    )
  },
})

async function migrateAllowList(
  network: INetworkConfig,
  privateKey: string,
  isDryRun: boolean,
  rpcUrlOverride?: string,
  environment: EnvironmentEnum = EnvironmentEnum.production
) {
  // Replace the manual deployment file reading with getDeployments
  let deploymentData: IDeploymentData
  try {
    deploymentData = await getDeployments(network.name, environment)
  } catch (error) {
    consola.error(`Error reading deployment data for ${network.name}:`, error)
    return
  }

  if (!deploymentData.LiFiDiamond) {
    consola.error(`No LiFiDiamond deployed on ${network.name}`)
    return
  }

  const diamondAddress = deploymentData.LiFiDiamond as Address
  consola.info(`💎 Diamond: ${diamondAddress}`)

  // Create viem clients
  const account = privateKeyToAccount(`0x${privateKey.replace(/^0x/, '')}`)
  const rpcUrl = rpcUrlOverride || network.rpcUrl
  consola.info(`🔍 RPC URL: ${rpcUrl}`)

  // Import the chain configuration
  const { getViemChainForNetworkName } = await import(
    '../utils/viemScriptHelpers'
  )
  const chain = getViemChainForNetworkName(network.name)

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  })

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  })

  // Check if already migrated

  try {
    const isMigrated = await publicClient.readContract({
      address: diamondAddress,
      abi: WHITELIST_MANAGER_ABI,
      functionName: 'isMigrated',
    })

    if (isMigrated) {
      consola.info('✅ Allow list already migrated')
      return
    }
  } catch (error) {
    consola.error(
      '❌ Most probably: WhitelistManagerFacet not found on diamond. Please ensure the facet is added to the diamond first.'
    )
    consola.info(
      '💡 The WhitelistManagerFacet needs to be deployed and added to the diamond before running the migration.'
    )
    throw error
  }

  const selectorsFilePath = './script/migration/flattened-selectors.json'
  let selectorsToRemove: string[] = []

  if (!existsSync(selectorsFilePath)) {
    consola.error(
      `❌ Flattened selectors file not found at ${selectorsFilePath}`
    )
    consola.info(
      '💡 Please run flatten-selectors script first to generate the file'
    )
    process.exit(1)
  }

  try {
    const fileContent = readFileSync(selectorsFilePath, 'utf-8')
    const { selectors } = JSON.parse(fileContent)
    selectorsToRemove = selectors
    consola.info(`📂 Loaded ${selectorsToRemove.length} selectors to remove`)
  } catch (error) {
    consola.error('❌ Failed to load selectors from file:', error)
    process.exit(1)
  }

  // Load current config (whitelistedSelectors.json)
  const whitelistedSelectorsFromFile =
    (whitelistedSelectors as IWhitelistedSelectors).selectors || []

  // Normalize current addresses to lowercase for comparison
  const selectorsToAdd = new Set(whitelistedSelectorsFromFile)
  const addressesToAdd = new Set(whitelistedAddresses[network.name] || [])

  consola.info(`Migration:`)
  consola.info(
    `   - ${
      Array.from(addressesToAdd).length
    } whitelisted addresses will be added`
  )
  consola.info(`   - ${selectorsToRemove.length} old selectors will be removed`)
  consola.info(
    `   - ${Array.from(selectorsToAdd).length} new selectors will be added`
  )

  // Convert to proper types
  const contractsToAdd = Array.from(addressesToAdd).map(
    (addr) => addr as Address
  )
  const selectorsToRemoveBytes4 = selectorsToRemove.map(
    (selector) => selector as Hex
  )
  const selectorsToAddBytes4 = Array.from(selectorsToAdd).map(
    (selector: string) => selector as Hex
  )

  if (isDryRun) {
    consola.info('🔍 [DRY RUN] Simulating migration...')

    try {
      // Simulate the transaction
      const gasEstimate = await publicClient.estimateGas({
        account: account.address,
        to: diamondAddress,
        data: encodeFunctionData({
          abi: WHITELIST_MANAGER_ABI,
          functionName: 'migrate',
          args: [selectorsToRemoveBytes4, contractsToAdd, selectorsToAddBytes4],
        }),
        value: 0n,
      })

      consola.info(`   Estimated gas: ${gasEstimate}`)
      consola.success('✅ [DRY RUN] Migration simulation successful')
    } catch (error) {
      consola.error('❌ [DRY RUN] Migration simulation failed:', error)
    }
  } else {
    // Execute the migration
    consola.info('🚀 Executing migration...')

    try {
      const hash = await walletClient.writeContract({
        address: diamondAddress,
        abi: WHITELIST_MANAGER_ABI,
        functionName: 'migrate',
        args: [selectorsToRemoveBytes4, contractsToAdd, selectorsToAddBytes4],
      })

      consola.info(`   Transaction hash: ${hash}`)
      consola.info('   Waiting for confirmation...')

      const receipt = await publicClient.waitForTransactionReceipt({ hash })

      if (receipt.status === 'success')
        consola.success('✅ Allow list migration completed successfully')
      else consola.error('❌ Migration transaction failed')
    } catch (error) {
      consola.error('❌ Migration failed:', error)
    }
  }
}

runMain(cmd)
