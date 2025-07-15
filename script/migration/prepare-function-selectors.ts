#!/usr/bin/env bun

/**
 * Function Selectors Preparation Script
 *
 * This script scans blockchain events to collect all ever-whitelisted function selectors
 * (previously called function signatures) from the old DexManagerFacet and saves them to a file.
 * This prepares the data for the allowListMigration script to use without re-scanning.
 */

import 'dotenv/config'

import { writeFileSync, existsSync, readFileSync } from 'fs'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { createPublicClient, http, type Address, type PublicClient } from 'viem'

import networksData from '../../config/networks.json'
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

interface INetworkSelectorData {
  network: string
  chainId: number
  diamondAddress: string
  scanFromBlock: string
  scanToBlock: string
  scannedAt: string
  totalEvents: number
  selectors: string[]
  scanDurationSeconds?: number
}

interface ISelectorsDataFile {
  version: string
  generatedAt: string
  networks: Record<string, INetworkSelectorData>
}

async function fetchEventsInChunks(
  publicClient: PublicClient,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
  chunkSize = 10000n
) {
  const events = []
  let currentFromBlock = fromBlock
  const totalBlocks = toBlock - fromBlock + 1n
  let processedBlocks = 0n

  consola.info(`🔍 Total blocks to scan: ${totalBlocks.toString()}`)

  while (currentFromBlock <= toBlock) {
    const currentToBlock =
      currentFromBlock + chunkSize - 1n > toBlock
        ? toBlock
        : currentFromBlock + chunkSize - 1n

    const progress = Math.min(
      100,
      Number((processedBlocks * 100n) / totalBlocks)
    )
    consola.info(
      `   [${progress.toFixed(
        0
      )}%] Fetching events from block ${currentFromBlock} to ${currentToBlock}`
    )

    const maxRetries = 3
    const retryDelay = 3000 // 3 seconds
    let retryCount = 0
    let success = false

    while (!success && retryCount <= maxRetries) {
      try {
        const chunkEvents = await publicClient.getLogs({
          address,
          event: {
            type: 'event',
            name: 'FunctionSignatureApprovalChanged',
            inputs: [
              { indexed: true, name: 'functionSignature', type: 'bytes4' },
              { indexed: true, name: 'approved', type: 'bool' },
            ],
          },
          fromBlock: currentFromBlock,
          toBlock: currentToBlock,
        })

        const blocksCovered = currentToBlock - currentFromBlock + 1n
        processedBlocks += blocksCovered
        events.push(...chunkEvents)
        consola.info(`   Found ${chunkEvents.length} events in this chunk`)
        success = true
      } catch (error) {
        retryCount++
        if (retryCount > maxRetries) {
          consola.error(
            `   Error fetching chunk ${currentFromBlock}-${currentToBlock} after ${maxRetries} retries:`,
            error
          )
          throw error
        }
        consola.warn(
          `   Error fetching chunk ${currentFromBlock}-${currentToBlock}, retry ${retryCount}/${maxRetries} in ${
            retryDelay / 1000
          }s...`
        )
        await new Promise((resolve) => setTimeout(resolve, retryDelay))
      }
    }

    // Update currentFromBlock for next chunk
    currentFromBlock = currentToBlock + 1n
  }

  consola.success(
    `✅ Completed scanning ${totalBlocks.toString()} blocks, found ${
      events.length
    } total events`
  )
  return events
}

async function scanNetworkSelectors(
  network: INetworkConfig,
  rpcUrlOverride?: string,
  fromBlockArg?: string,
  environment: EnvironmentEnum = EnvironmentEnum.production
): Promise<INetworkSelectorData> {
  const startTime = Date.now()
  consola.info(
    `\n🔍 Processing network: ${network.name} (Chain ID: ${network.chainId})`
  )

  // Get deployment data
  let deploymentData: IDeploymentData
  try {
    deploymentData = await getDeployments(network.name, environment)
  } catch (error) {
    consola.error(`Error reading deployment data for ${network.name}:`, error)
    throw error
  }

  if (!deploymentData.LiFiDiamond)
    throw new Error(`No LiFiDiamond deployed on ${network.name}`)

  const diamondAddress = deploymentData.LiFiDiamond as Address
  consola.info(`💎 Diamond: ${diamondAddress}`)

  // Create viem client
  const rpcUrl = rpcUrlOverride || network.rpcUrl
  consola.info(`🔍 RPC URL: ${rpcUrl}`)

  const { getViemChainForNetworkName } = await import(
    '../utils/viemScriptHelpers'
  )
  const chain = getViemChainForNetworkName(network.name)

  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  })

  // Determine block range for event scanning
  let fromBlock = 0n
  if (fromBlockArg) {
    fromBlock = BigInt(fromBlockArg)
  } else {
    const currentBlock = await publicClient.getBlockNumber()
    fromBlock = currentBlock > 100000n ? currentBlock - 100000n : 0n
  }

  const latestBlock = await publicClient.getBlockNumber()
  consola.info(`📊 Current block: ${latestBlock.toString()}`)
  consola.info(`🔍 Scanning events from block ${fromBlock} to ${latestBlock}`)

  // Fetch events
  consola.info('📡 Fetching FunctionSignatureApprovalChanged events...')
  const selectorApprovalEvents = await fetchEventsInChunks(
    publicClient,
    diamondAddress,
    fromBlock,
    latestBlock
  )

  // Get all ever-whitelisted selectors from events
  const everWhitelistedSelectors = new Set(
    selectorApprovalEvents
      .filter((event) => event.args.approved) // only get events where selectors were approved
      .map((event) => event.args.functionSignature as string)
  )

  const selectors = Array.from(everWhitelistedSelectors)

  const duration = ((Date.now() - startTime) / 1000).toFixed(2)
  consola.success(
    `✅ Found ${selectors.length} unique selectors for ${network.name} (took ${duration}s)`
  )

  return {
    network: network.name,
    chainId: network.chainId,
    diamondAddress,
    scanFromBlock: fromBlock.toString(),
    scanToBlock: latestBlock.toString(),
    scannedAt: new Date().toISOString(),
    totalEvents: selectorApprovalEvents.length,
    selectors,
    scanDurationSeconds: parseFloat(duration),
  }
}

// Define the command
const cmd = defineCommand({
  meta: {
    name: 'prepare-function-selectors',
    description:
      'Scan blockchain events to prepare function selectors data file',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Network to scan (optional, if not provided will scan all networks)',
      required: false,
    },
    rpcUrl: {
      type: 'string',
      description: 'Override RPC URL for the network',
      required: false,
    },
    fromBlock: {
      type: 'string',
      description:
        'Block number to start scanning from (default: diamond deployment block)',
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
    outputFile: {
      type: 'string',
      description:
        'Output file path (default: ./script/migration/functionSelectors.json)',
      required: false,
      default: './script/migration/functionSelectors.json',
    },
  },
  async run({ args }) {
    const rpcUrlOverride = args?.rpcUrl
    const fromBlockArg = args?.fromBlock
    const environment =
      args?.environment === EnvironmentEnum[EnvironmentEnum.staging]
        ? EnvironmentEnum.staging
        : EnvironmentEnum.production
    const outputFile =
      args?.outputFile || './script/migration/functionSelectors.json'

    consola.info(`🚀 Starting function selectors preparation...`)
    consola.info(`📁 Output file: ${outputFile}`)
    consola.info(
      `🌍 Environment: ${
        environment === EnvironmentEnum.staging ? 'staging' : 'production'
      }`
    )

    // Load existing data if file exists
    let existingData: ISelectorsDataFile = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      networks: {},
    }

    if (existsSync(outputFile)) {
      try {
        const fileContent = readFileSync(outputFile, 'utf-8')
        existingData = JSON.parse(fileContent)
        consola.info(
          `📂 Loaded existing data with ${
            Object.keys(existingData.networks).length
          } networks`
        )
      } catch (error) {
        consola.warn('Failed to load existing data, starting fresh:', error)
      }
    }

    // Determine which networks to scan
    const networksToScan: INetworkConfig[] = []

    if (args.network) {
      const networkName = args.network.toLowerCase()
      const networkConfig = (networksData as Record<string, INetworkConfig>)[
        networkName
      ]

      if (!networkConfig) {
        consola.error(`Network '${args.network}' not found in configuration`)
        process.exit(1)
      }

      networksToScan.push(networkConfig)
    } else {
      // Scan all networks
      for (const [, networkConfig] of Object.entries(
        networksData as Record<string, INetworkConfig>
      )) {
        if (networkConfig.status === 'active') {
          networksToScan.push(networkConfig)
        }
      }
    }

    consola.info(`📡 Will scan ${networksToScan.length} network(s)`)

    // Scan each network
    for (const network of networksToScan) {
      try {
        const networkData = await scanNetworkSelectors(
          network,
          rpcUrlOverride,
          fromBlockArg,
          environment
        )

        existingData.networks[network.name] = networkData
        existingData.generatedAt = new Date().toISOString()

        // Save after each network to avoid losing data
        writeFileSync(outputFile, JSON.stringify(existingData, null, 2))
        consola.success(`💾 Saved data for ${network.name}`)
      } catch (error) {
        consola.error(`❌ Failed to scan ${network.name}:`, error)
        // Continue with other networks
      }
    }

    consola.success(`🎉 Completed scanning! Data saved to ${outputFile}`)
    consola.info(
      `📊 Total networks processed: ${
        Object.keys(existingData.networks).length
      }`
    )

    // Show summary
    for (const [networkName, data] of Object.entries(existingData.networks)) {
      consola.info(`   ${networkName}: ${data.selectors.length} selectors`)
    }
  },
})

runMain(cmd)
