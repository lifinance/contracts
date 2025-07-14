#!/usr/bin/env bun

/**
 * Allow List Migration Script
 *
 * This script migrates the allow list configuration by:
 * 1. Fetching all ever-whitelisted addresses and selectors from blockchain events
 * 2. Loading current configuration from config files
 * 3. Determining what to remove and what to add
 * 4. Calling the migrate function with the appropriate parameters
 */

import 'dotenv/config'
import { readFileSync } from 'fs'
import { join } from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  encodeFunctionData,
  type Address,
  type PublicClient,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import networksData from '../../config/networks.json'
import whitelistedAddresses from '../../config/whitelistedAddresses.json'
import whitelistedSelectors from '../../config/whitelistedSelectors.json'
import { type SupportedChain } from '../common/types'

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
    fromBlock: {
      type: 'string',
      description: 'Block number to start scanning from (default: earliest)',
      required: false,
    },
  },
  async run({ args }) {
    const privateKey = args?.privateKey || process.env.PRIVATE_KEY_PRODUCTION
    const isDryRun = Boolean(args?.dryRun)
    const rpcUrlOverride = args?.rpcUrl
    const fromBlockArg = args?.fromBlock

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
      fromBlockArg
    )
  },
})

// Add this function to get the diamond deployment block
async function getDiamondDeploymentBlock(
  publicClient: PublicClient,
  diamondAddress: Address,
  create3FactoryAddress: Address
): Promise<bigint> {
  consola.info('🔍 Looking for diamond deployment block...')

  // Get the CREATE3 factory deployment event
  const deploymentLogs = await publicClient.getLogs({
    address: create3FactoryAddress,
    event: {
      type: 'event',
      name: 'Deployed',
      inputs: [
        { indexed: true, name: 'deployer', type: 'address' },
        { indexed: true, name: 'salt', type: 'bytes32' },
        { indexed: true, name: 'deployed', type: 'address' },
      ],
    },
    fromBlock: 'earliest',
    toBlock: 'latest',
  })

  // Find the log where the deployed address matches our diamond
  const deploymentLog = deploymentLogs.find(
    (log) => log.args.deployed?.toLowerCase() === diamondAddress.toLowerCase()
  )

  if (!deploymentLog) {
    consola.warn(
      'Could not find diamond deployment block, falling back to last 100k blocks'
    )
    const currentBlock = await publicClient.getBlockNumber()
    return currentBlock > 100000n ? currentBlock - 100000n : 0n
  }

  consola.info(`Found diamond deployment at block ${deploymentLog.blockNumber}`)
  return deploymentLog.blockNumber
}

async function migrateAllowList(
  network: INetworkConfig,
  privateKey: string,
  isDryRun: boolean,
  rpcUrlOverride?: string,
  fromBlockArg?: string
) {
  // Load deployment data
  const deploymentPath = join(
    process.cwd(),
    'deployments',
    `${network.name}.json`
  )

  let deploymentData: IDeploymentData
  try {
    deploymentData = JSON.parse(readFileSync(deploymentPath, 'utf-8'))
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
      '❌ WhitelistManagerFacet v1.0.1 with migration logic is not yet deployed to the diamond.'
    )
    return
  }

  // Get CREATE3Factory address from networks.json
  const create3FactoryAddress = networksData[network.name]
    .create3Factory as Address
  if (!create3FactoryAddress)
    consola.warn(
      'CREATE3Factory address not found in networks.json, falling back to default block range'
    )

  // Determine block range for event scanning
  let fromBlock: bigint | 'earliest' = 'earliest'
  if (fromBlockArg) fromBlock = BigInt(fromBlockArg)
  else if (create3FactoryAddress)
    try {
      fromBlock = await getDiamondDeploymentBlock(
        publicClient,
        diamondAddress,
        create3FactoryAddress
      )
    } catch (error) {
      consola.warn(
        'Failed to get diamond deployment block, using default range:',
        error
      )
      const currentBlock = await publicClient.getBlockNumber()
      fromBlock = currentBlock > 100000n ? currentBlock - 100000n : 0n
    }
  else
    fromBlock =
      (await publicClient.getBlockNumber()) > 100000n
        ? (await publicClient.getBlockNumber()) - 100000n
        : 0n

  consola.info(`🔍 Scanning events from block ${fromBlock} to latest`)

  // Fetch all ever-whitelisted selectors (previously they where named function signatures from DexManagerFacet)
  consola.info(
    '📡 Fetching FunctionSignatureApprovalChanged events which where used in the old DexManagerFacet...'
  )
  const selectorApprovalEvents = await publicClient.getLogs({
    address: diamondAddress,
    event: {
      type: 'event',
      name: 'FunctionSignatureApprovalChanged',
      inputs: [
        { indexed: true, name: 'functionSignature', type: 'bytes4' },
        { indexed: true, name: 'approved', type: 'bool' },
      ],
    },
    fromBlock,
    toBlock: 'latest',
  })

  // Get all ever-whitelisted selectors from events (previously they where named function signatures from DexManagerFacet)
  const everWhitelistedSelectors = new Set(
    selectorApprovalEvents
      .filter((event) => event.args.approved) // only get events where selectors were approved
      .map((event) => event.args.functionSignature as string)
  )

  const selectorsToRemove = Array.from(everWhitelistedSelectors)

  // Load current config (whitelistedSelectors.json)
  const whitelistedSelectorsFromFile =
    (whitelistedSelectors as IWhitelistedSelectors).selectors || []

  // Normalize current addresses to lowercase for comparison
  const selectorsToAdd = new Set(whitelistedSelectorsFromFile)
  const addressesToAdd = new Set(whitelistedAddresses[network.name] || [])

  consola.info(`Migration plan:`)
  consola.info(
    `   - Will be ${Array.from(addressesToAdd).length} whitelisted addresses`
  )
  consola.info(`   - Remove ${selectorsToRemove.length} old selectors`)
  consola.info(`   - Add ${Array.from(selectorsToAdd).length} new selectors`)

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
