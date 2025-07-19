#!/usr/bin/env bun

/**
 * Function Selectors Preparation Script
 *
 * This script scans blockchain events to collect historical function selector approvals,
 * preparing data for the allowlist migration. Since we can't clear mappings on-chain,
 * we need a complete record of all previously approved selectors to properly reset the state.
 * The script also incorporates selectors from the whitelistedSelectors.json configuration file
 * to ensure a complete set of all required selectors.
 *
 * Key Features:
 * - Parallel Processing: Scans multiple networks concurrently
 * - Configurable chunk sizes per network to handle RPC limitations
 * - Support for custom RPC endpoints when public ones are unreliable
 * - Automatic retry mechanism with backoff for failed requests
 * - Timeout handling for unresponsive RPCs
 * - Integration with whitelistedSelectors.json for additional selectors
 *
 * Process:
 * 1. Loads network-specific configurations from prepareFunctionSelectorsConfig.json:
 *    - Custom chunk sizes for event scanning
 *    - RPC preferences (custom vs public)
 *    - Network-specific deployment blocks
 *    - Skip flags for specific networks
 *
 * 2. Scans FunctionSignatureApprovalChanged events from each network:
 *    - Processes blocks in configurable chunks to handle RPC limitations
 *    - Tracks only approval events (filters out revocation events)
 *    - Saves results progressively to handle large datasets
 *
 * 3. Generates functionSelectorsResult.json containing:
 *    - Complete list of approved selectors per network
 *    - Scanning metadata (blocks, timestamps, duration)
 *    - Network-specific information (chain IDs, addresses)
 *
 * 4. Creates flattened-selectors.json:
 *    - Combines selectors from all networks
 *    - Incorporates selectors from whitelistedSelectors.json
 *    - Removes duplicates across all sources
 *    - Sorts selectors for consistency
 *    - Includes total count of unique selectors
 *
 * The output files are essential for the allowlist migration process,
 * providing both network-specific data and a complete, deduplicated set
 * of selectors that need to be explicitly removed to reset the contract state.
 * The inclusion of whitelistedSelectors.json ensures that any manually configured
 * selectors are preserved in the final output.
 */

import 'dotenv/config'

import { writeFileSync, existsSync, readFileSync } from 'fs'
import path from 'path'

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
  selectors: string[]
  scanDurationSeconds?: number
}

interface ISelectorsDataFile {
  version: string
  generatedAt: string
  networks: Record<string, INetworkSelectorData>
}

interface IChunkConfig {
  chunkSize?: number
  useCustomRPC?: boolean
  deploymentBlock?: number | null
  skip?: boolean
  notes?: string
}

interface IChunkRangeConfig {
  version: string
  description: string
  lastUpdated: string
  networks: Record<string, IChunkConfig>
}

interface IScanResult {
  success: boolean
  network: string
  data?: INetworkSelectorData
  error?: string
  duration?: number
}

interface IScanSummary {
  totalNetworks: number
  successfulScans: number
  failedScans: number
  totalSelectors: number
  totalDuration: number
  successfulNetworks: string[]
  failedNetworks: { network: string; error: string }[]
}

async function fetchEventsInChunks(
  publicClient: PublicClient,
  address: Address,
  fromBlock: bigint,
  toBlock: bigint,
  networkName: string,
  chunkSize: bigint
) {
  const events = []
  let currentFromBlock = fromBlock
  const totalBlocks = toBlock - fromBlock + 1n
  let processedBlocks = 0n

  consola.info(
    `🔍 [${networkName}] Total blocks to scan: ${totalBlocks.toString()}`
  )
  consola.info(
    `🔧 [${networkName}] Using chunk size: ${chunkSize.toString()} blocks`
  )

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
      `   [${networkName}] [${progress.toFixed(
        0
      )}%] Fetching events from block ${currentFromBlock} to ${currentToBlock}`
    )

    const maxRetries = 10
    const baseRetryDelay = 5000 // 5 seconds
    let retryCount = 0
    let success = false

    while (!success && retryCount <= maxRetries) {
      try {
        // Add timeout using AbortController
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 60000) // 60 second timeout

        const chunkEvents = await publicClient
          .getLogs({
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
          .finally(() => clearTimeout(timeout))

        const blocksCovered = currentToBlock - currentFromBlock + 1n
        processedBlocks += blocksCovered
        events.push(...chunkEvents)
        consola.info(
          `   [${networkName}] Found ${chunkEvents.length} events in this chunk`
        )
        success = true
      } catch (error: any) {
        // Add ': any' type annotation
        retryCount++

        // Determine error type and appropriate response
        const errorMessage = error.message?.toLowerCase() || ''
        const isTimeout =
          error.name === 'AbortError' ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('network error') ||
          errorMessage.includes('request timed out') ||
          errorMessage.includes('took too long')

        const isRateLimited =
          error.status === 429 ||
          errorMessage.includes('too many requests') ||
          errorMessage.includes('rate limit')

        const isBlockRangeError =
          errorMessage.includes('block range') ||
          errorMessage.includes('too many blocks') ||
          errorMessage.includes('maximum') ||
          errorMessage.includes('exceeded')

        const isRPCError =
          error.status >= 500 ||
          errorMessage.includes('internal error') ||
          errorMessage.includes('service unavailable') ||
          errorMessage.includes('bad gateway')

        if (retryCount > maxRetries) {
          consola.error(
            `❌ [${networkName}] Error fetching chunk ${currentFromBlock}-${currentToBlock} after ${maxRetries} retries:`,
            error
          )
          throw error
        }

        // Calculate retry delay based on error type
        let waitTime = baseRetryDelay
        if (isRateLimited) {
          waitTime = baseRetryDelay * Math.pow(2, retryCount) // Exponential backoff for rate limits
        } else if (isTimeout || isRPCError) {
          waitTime = baseRetryDelay * (retryCount + 1) // Linear increase for timeouts/RPC errors
        } else if (isBlockRangeError) {
          // For block range errors, we should probably reduce chunk size instead of retrying
          consola.error(
            `❌ [${networkName}] Block range error for chunk ${currentFromBlock}-${currentToBlock}. Consider reducing chunk size.`,
            error
          )
          throw error
        }

        // Cap maximum wait time at 60 seconds
        waitTime = Math.min(waitTime, 60000)

        const errorType = isTimeout
          ? 'Timeout'
          : isRateLimited
          ? 'Rate Limited'
          : isRPCError
          ? 'RPC Error'
          : isBlockRangeError
          ? 'Block Range Error'
          : 'Network Error'

        consola.warn(
          `⚠️  [${networkName}] ${errorType} fetching chunk ${currentFromBlock}-${currentToBlock}, retry ${retryCount}/${maxRetries} in ${
            waitTime / 1000
          }s...`
        )
        await new Promise((resolve) => setTimeout(resolve, waitTime))
      }
    }

    // Update currentFromBlock for next chunk
    currentFromBlock = currentToBlock + 1n
  }

  consola.success(
    `✅ [${networkName}] Completed scanning ${totalBlocks.toString()} blocks, found ${
      events.length
    } total events`
  )
  return events
}

async function scanNetworkSelectors(
  network: INetworkConfig,
  chunkConfig: IChunkConfig,
  rpcUrlOverride?: string,
  environment: EnvironmentEnum = EnvironmentEnum.production
): Promise<IScanResult> {
  const startTime = Date.now()

  try {
    consola.info(
      `\n🔍 [${network.name}] Processing network (Chain ID: ${network.chainId})`
    )

    // Get deployment data
    let deploymentData: IDeploymentData
    try {
      deploymentData = await getDeployments(network.name, environment)
    } catch (error) {
      throw new Error(`Error reading deployment data: ${error}`)
    }

    if (!deploymentData.LiFiDiamond) {
      throw new Error(`No LiFiDiamond deployed on ${network.name}`)
    }

    const diamondAddress = deploymentData.LiFiDiamond as Address
    consola.info(`💎 [${network.name}] Diamond: ${diamondAddress}`)

    // Determine RPC URL to use
    let rpcUrl = rpcUrlOverride || network.rpcUrl

    // Check if we should use custom RPC from environment variables
    if (chunkConfig.useCustomRPC && !rpcUrlOverride) {
      const envVarName = `ETH_NODE_URI_${network.name.toUpperCase()}`
      const customRpcUrl = process.env[envVarName]

      if (customRpcUrl) {
        rpcUrl = customRpcUrl
        consola.info(`🔧 [${network.name}] Using custom RPC from ${envVarName}`)
      } else {
        consola.warn(
          `⚠️  [${network.name}] Custom RPC requested but ${envVarName} not found in environment, using default RPC`
        )
      }
    }

    consola.info(`🔍 [${network.name}] RPC URL: ${rpcUrl}`)

    // Create viem client
    const { getViemChainForNetworkName } = await import(
      '../utils/viemScriptHelpers'
    )
    const chain = getViemChainForNetworkName(network.name)

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    const latestBlock = await publicClient.getBlockNumber()

    // Use deployment block from config, fallback to last 100k blocks if not specified
    let fromBlock: bigint
    if (chunkConfig.deploymentBlock && chunkConfig.deploymentBlock !== null) {
      fromBlock = BigInt(chunkConfig.deploymentBlock)
      consola.info(`📊 [${network.name}] Scanning from deployment block`)
    } else {
      fromBlock = latestBlock - 100000n // Fallback to last 100k blocks
      consola.info(
        `📊 [${network.name}] No deployment block specified, scanning last 100k blocks`
      )
    }

    // Get chunk size with default fallback
    const chunkSize = chunkConfig.chunkSize || 10000 // Default to 10k blocks
    consola.info(`   From block: ${fromBlock}`)
    consola.info(`   To block: ${latestBlock}`)
    consola.info(`   Total blocks to scan: ${latestBlock - fromBlock + 1n}`)
    consola.info(`   Chunk size: ${chunkSize} blocks`)

    // Fetch events with configured chunk size
    const selectorApprovalEvents = await fetchEventsInChunks(
      publicClient,
      diamondAddress,
      fromBlock,
      latestBlock,
      network.name,
      BigInt(chunkSize)
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
      `✅ [${network.name}] Found ${selectors.length} unique selectors (took ${duration}s)`
    )

    const networkData: INetworkSelectorData = {
      network: network.name,
      chainId: network.chainId,
      diamondAddress,
      scanFromBlock: fromBlock.toString(),
      scanToBlock: latestBlock.toString(),
      scannedAt: new Date().toISOString(),
      selectors,
      scanDurationSeconds: parseFloat(duration),
    }

    return {
      success: true,
      network: network.name,
      data: networkData,
      duration: parseFloat(duration),
    }
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000).toFixed(2)
    const errorMessage = error instanceof Error ? error.message : String(error)

    consola.error(
      `❌ [${network.name}] Failed after ${duration}s: ${errorMessage}`
    )

    return {
      success: false,
      network: network.name,
      error: errorMessage,
      duration: parseFloat(duration),
    }
  }
}

function loadDeploymentBlocks(filePath: string): IChunkRangeConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Deployment blocks file not found: ${filePath}`)
  }

  try {
    const fileContent = readFileSync(filePath, 'utf-8')
    return JSON.parse(fileContent)
  } catch (error) {
    throw new Error(`Failed to parse deployment blocks file: ${error}`)
  }
}

function generateSummary(results: IScanResult[]): IScanSummary {
  const successful = results.filter((r) => r.success)
  const failed = results.filter((r) => !r.success)

  const totalSelectors = successful.reduce((sum, result) => {
    return sum + (result.data?.selectors.length || 0)
  }, 0)

  const totalDuration = results.reduce((sum, result) => {
    return sum + (result.duration || 0)
  }, 0)

  return {
    totalNetworks: results.length,
    successfulScans: successful.length,
    failedScans: failed.length,
    totalSelectors,
    totalDuration,
    successfulNetworks: successful.map((r) => r.network),
    failedNetworks: failed.map((r) => ({
      network: r.network,
      error: r.error || 'Unknown error',
    })),
  }
}

function flattenAndSaveSelectors(
  existingData: ISelectorsDataFile,
  baseDir: string
) {
  // Create a Set to automatically handle deduplication
  const uniqueSelectors = new Set<string>()

  // Iterate through all networks and add their selectors to the Set
  Object.values(existingData.networks).forEach((network) => {
    network.selectors.forEach((selector) => {
      uniqueSelectors.add(selector)
    })
  })

  // Read and add selectors from whitelistedSelectors.json
  try {
    const whitelistedSelectorsPath = path.join(
      process.cwd(),
      'config',
      'whitelistedSelectors.json'
    )
    if (existsSync(whitelistedSelectorsPath)) {
      const whitelistedSelectors = JSON.parse(
        readFileSync(whitelistedSelectorsPath, 'utf-8')
      )
      whitelistedSelectors.selectors.forEach((selector: string) => {
        uniqueSelectors.add(selector)
      })
      consola.success(`📄 Added selectors from whitelistedSelectors.json`)
    } else {
      consola.warn(
        `⚠️  whitelistedSelectors.json not found in config directory`
      )
    }
  } catch (error) {
    consola.error(`❌ Error reading whitelistedSelectors.json:`, error)
  }

  // Convert Set to sorted array for consistent output
  const sortedSelectors = Array.from(uniqueSelectors).sort()

  // Create output object
  const output = {
    totalUniqueSelectors: sortedSelectors.length,
    selectors: sortedSelectors,
  }

  // Write to flattened-selectors.json
  const outputPath = path.join(baseDir, 'flattened-selectors.json')
  writeFileSync(outputPath, JSON.stringify(output, null, 2))

  consola.success(`\n📄 Flattened selectors summary:`)
  consola.info(`   Total unique selectors: ${sortedSelectors.length}`)
  consola.info(`   Output written to: ${outputPath}`)
}

// Define the command
const cmd = defineCommand({
  meta: {
    name: 'prepare-function-selectors',
    description:
      'Scan blockchain events in parallel to prepare function selectors data file',
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
      description:
        'Override RPC URL for the network (only works with single network)',
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
        'Output file path (default: ./script/migration/functionSelectorsResult.json)',
      required: false,
      default: './script/migration/functionSelectorsResult.json',
    },
    deploymentBlocksFile: {
      type: 'string',
      description:
        'Deployment blocks config file (default: ./script/migration/prepareFunctionSelectorsConfig.json)',
      required: false,
      default: './script/migration/prepareFunctionSelectorsConfig.json',
    },
    maxConcurrency: {
      type: 'string',
      description:
        'Maximum number of networks to scan concurrently (default: 10)',
      required: false,
      default: '10',
    },
  },
  async run({ args }) {
    const rpcUrlOverride = args?.rpcUrl
    const environment =
      args?.environment === EnvironmentEnum[EnvironmentEnum.staging]
        ? EnvironmentEnum.staging
        : EnvironmentEnum.production
    const outputFile =
      args?.outputFile || './script/migration/functionSelectorsResult.json'
    const deploymentBlocksFile =
      args?.deploymentBlocksFile ||
      './script/migration/prepareFunctionSelectorsConfig.json'
    const maxConcurrency = parseInt(args?.maxConcurrency || '10')

    consola.info(`🚀 Starting parallel function selectors preparation...`)
    consola.info(`📁 Output file: ${outputFile}`)
    consola.info(`📁 Deployment blocks file: ${deploymentBlocksFile}`)
    consola.info(`🔧 Max concurrency: ${maxConcurrency}`)
    consola.info(
      `🌍 Environment: ${
        environment === EnvironmentEnum.staging ? 'staging' : 'production'
      }`
    )

    // Load deployment blocks configuration
    let chunkConfigs: IChunkRangeConfig
    try {
      chunkConfigs = loadDeploymentBlocks(deploymentBlocksFile)
    } catch (error) {
      consola.error(`Failed to load chunk configurations: ${error}`)
      process.exit(1)
    }

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
    const networksToScan: {
      network: INetworkConfig
      chunkConfig: IChunkConfig
    }[] = []

    if (args.network) {
      const networkName = args.network.toLowerCase()
      const networkConfig = (networksData as Record<string, INetworkConfig>)[
        networkName
      ]

      if (!networkConfig) {
        consola.error(`Network '${args.network}' not found in configuration`)
        process.exit(1)
      }

      const chunkConfig = chunkConfigs.networks[networkName]
      if (!chunkConfig) {
        consola.error(`No chunk size configured for network '${networkName}'`)
        process.exit(1)
      }

      networksToScan.push({ network: networkConfig, chunkConfig })
    } else {
      // Scan all active networks that have chunk sizes configured
      for (const [networkName, networkConfig] of Object.entries(
        networksData as Record<string, INetworkConfig>
      )) {
        if (networkConfig.status === 'active') {
          const chunkConfig = chunkConfigs.networks[networkName]
          if (chunkConfig) {
            // Skip networks that are marked to be skipped
            if (chunkConfig.skip) {
              consola.info(
                `⏭️  Skipping ${networkName}: marked as skip in config`
              )
              continue
            }
            networksToScan.push({ network: networkConfig, chunkConfig })
          } else {
            consola.warn(
              `⚠️  Skipping ${networkName}: no chunk size configured`
            )
          }
        }
      }
    }

    consola.info(`📡 Will scan ${networksToScan.length} network(s) in parallel`)

    // Process networks in batches with concurrency limit
    const results: IScanResult[] = []
    const startTime = Date.now()

    for (let i = 0; i < networksToScan.length; i += maxConcurrency) {
      const batch = networksToScan.slice(i, i + maxConcurrency)
      consola.info(
        `\n🔄 Processing batch ${
          Math.floor(i / maxConcurrency) + 1
        }/${Math.ceil(networksToScan.length / maxConcurrency)}`
      )

      const batchPromises = batch.map(({ network, chunkConfig }) =>
        scanNetworkSelectors(
          network,
          chunkConfig,
          args.network ? rpcUrlOverride : undefined, // Only use RPC override for single network
          environment
        )
      )

      const batchResults = await Promise.allSettled(batchPromises)

      // Process batch results
      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value)

          // Save successful results immediately
          if (result.value.success && result.value.data) {
            existingData.networks[result.value.network] = result.value.data
            existingData.generatedAt = new Date().toISOString()

            try {
              writeFileSync(outputFile, JSON.stringify(existingData, null, 2))
              consola.success(`💾 Saved data for ${result.value.network}`)
            } catch (error) {
              consola.error(
                `Failed to save data for ${result.value.network}:`,
                error
              )
            }
          }
        } else {
          // Handle completely failed promises (shouldn't happen with our error handling)
          results.push({
            success: false,
            network: 'unknown',
            error: result.reason?.message || 'Promise rejected',
          })
        }
      }
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2)
    const summary = generateSummary(results)

    // Final save
    writeFileSync(outputFile, JSON.stringify(existingData, null, 2))

    // Print comprehensive summary
    consola.success(`\n🎉 Parallel scanning completed in ${totalTime}s!`)
    consola.info(`📊 SCAN SUMMARY:`)
    consola.info(`   Networks processed: ${summary.totalNetworks}`)
    consola.info(`   Successful scans: ${summary.successfulScans}`)
    consola.info(`   Failed scans: ${summary.failedScans}`)
    consola.info(`   Total selectors found: ${summary.totalSelectors}`)
    consola.info(`   Total scan time: ${summary.totalDuration.toFixed(2)}s`)

    if (summary.successfulScans > 0) {
      consola.success(`\n✅ SUCCESSFUL NETWORKS (${summary.successfulScans}):`)
      summary.successfulNetworks.forEach((network) => {
        const data = existingData.networks[network]
        consola.info(
          `   ${network}: ${data?.selectors.length ?? 0} selectors (${
            data?.scanDurationSeconds ?? 0
          }s)`
        )
      })
    }

    if (summary.failedScans > 0) {
      consola.error(`\n❌ FAILED NETWORKS (${summary.failedScans}):`)
      summary.failedNetworks.forEach(({ network, error }) => {
        consola.error(`   ${network}: ${error}`)
      })
    }

    // Add flattening step
    consola.info(`\n🔄 Flattening selectors from all networks...`)
    flattenAndSaveSelectors(existingData, path.dirname(outputFile))

    process.exit(summary.failedScans > 0 ? 1 : 0)
  },
})

runMain(cmd)
