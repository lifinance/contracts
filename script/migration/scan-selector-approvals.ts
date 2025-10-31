#!/usr/bin/env bun

/**
 * Function Selectors Preparation Script
 *
 * This script scans blockchain events to collect historical function selector approvals,
 * preparing data for the allowlist migration. Since we can't clear mappings on-chain,
 * we need a complete record of all previously approved selectors to properly reset the state.
 * The script also incorporates selectors from the sigs.json configuration file
 * to ensure a complete set of all required selectors.
 *
 * Key Features:
 * - Parallel Processing: Scans multiple networks concurrently
 * - Configurable chunk sizes per network to handle RPC limitations
 * - Support for custom RPC endpoints when public ones are unreliable
 * - Automatic retry mechanism with backoff for failed requests (via eventScanner utility)
 * - Timeout handling for unresponsive RPCs
 * - Integration with sigs.json for additional selectors
 *
 * Process:
 * 1. Loads network-specific configurations from scan-selector-approvals-config.json:
 *    - Custom chunk sizes for event scanning
 *    - RPC preferences (custom vs public)
 *    - Network-specific deployment blocks
 *    - Skip flags for specific networks
 *
 * 2. Scans FunctionSignatureApprovalChanged events from each network using eventScanner:
 *    - Processes blocks in configurable chunks to handle RPC limitations
 *    - Tracks only approval events (filters out revocation events)
 *    - Saves results progressively to handle large datasets
 *    - Provides detailed scanning statistics and error handling
 *
 * 3. Generates tempFunctionSelectorsResult.json (temporary diagnostic file):
 *    - This is a TEMPORARY file used only for debugging and verification
 *    - Provides detailed per-network breakdown of the scanning process
 *    - Shows exactly which selectors were found on each network
 *    - Includes metadata like block ranges and timestamps for auditing
 *    - Helps track scanning duration and success rates
 *    - NOT used in production - only for development/debugging
 *
 * 4. Updates functionSelectorsToRemove.json (production config):
 *    - This is the ACTUAL configuration file used by the deployment scripts
 *    - Combines all unique selectors from all networks
 *    - Adds selectors from whitelist.json (DEXS + PERIPHERY sections)
 *    - Optionally adds selectors from sigs.json (deprecated)
 *    - Removes duplicates and sorts for consistency
 *    - Contains only the essential functionSelectorsToRemove field
 *    - Used directly by UpdateWhitelistManagerFacet.s.sol during deployment
 *
 * Output Files:
 * 1. tempFunctionSelectorsResult.json:
 *    - Location: script/migration/tempFunctionSelectorsResult.json
 *    - Purpose: Temporary diagnostic data
 *    - Contains: Detailed per-network scanning results
 *    - Usage: Development, debugging, and verification only
 *    - Can be safely deleted after verification
 *
 * 2. functionSelectorsToRemove.json:
 *    - Location: config/functionSelectorsToRemove.json
 *    - Purpose: Production configuration
 *    - Contains: Final deduplicated selector list
 *    - Usage: Required for deployment
 */

import 'dotenv/config'

import { writeFileSync, existsSync, readFileSync } from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { createPublicClient, http, type Address } from 'viem'

import networksData from '../../config/networks.json'
import { EnvironmentEnum, type SupportedChain } from '../common/types'
import { getDeployments } from '../utils/deploymentHelpers'
import { scanEventsInChunks } from '../utils/eventScanner'

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

    const { events: selectorApprovalEvents } = await scanEventsInChunks({
      publicClient,
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
      toBlock: latestBlock,
      networkName: network.name,
      chunkSize: BigInt(chunkSize),
    })

    // Get all ever-whitelisted selectors from events
    const everWhitelistedSelectors = new Set(
      selectorApprovalEvents
        .filter(
          (
            event: unknown
          ): event is {
            args: { approved: boolean; functionSignature: string }
          } => {
            if (typeof event !== 'object' || event === null) return false
            const eventObj = event as Record<string, unknown>
            if (
              !('args' in eventObj) ||
              typeof eventObj.args !== 'object' ||
              eventObj.args === null
            )
              return false
            const args = eventObj.args as Record<string, unknown>
            return (
              'approved' in args &&
              typeof args.approved === 'boolean' &&
              args.approved === true &&
              'functionSignature' in args &&
              typeof args.functionSignature === 'string'
            )
          }
        )
        .map((event) => event.args.functionSignature)
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

function extractSelectorsFromWhitelist(): string[] {
  const whitelistPath = path.join(process.cwd(), 'config', 'whitelist.json')
  const selectors = new Set<string>()

  try {
    if (!existsSync(whitelistPath)) {
      consola.error(
        `❌ whitelist.json not found in config directory - this file is required!`
      )
      throw new Error('whitelist.json is required but not found')
    }

    const whitelistData = JSON.parse(readFileSync(whitelistPath, 'utf-8'))

    // Extract selectors from DEXS section
    if (whitelistData.DEXS && Array.isArray(whitelistData.DEXS)) {
      for (const dex of whitelistData.DEXS) {
        if (dex.contracts && typeof dex.contracts === 'object') {
          // Iterate through all networks in contracts
          for (const [_network, contracts] of Object.entries(dex.contracts)) {
            if (Array.isArray(contracts)) {
              for (const contract of contracts) {
                if (
                  contract.functions &&
                  typeof contract.functions === 'object'
                ) {
                  // Extract selectors from functions object
                  for (const selector of Object.keys(contract.functions)) {
                    if (selector.match(/^0x[a-fA-F0-9]{8}$/)) {
                      selectors.add(selector)
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    // Extract selectors from PERIPHERY section
    if (
      whitelistData.PERIPHERY &&
      typeof whitelistData.PERIPHERY === 'object'
    ) {
      for (const [_network, networkData] of Object.entries(
        whitelistData.PERIPHERY
      )) {
        if (networkData && typeof networkData === 'object') {
          // Handle both production and staging environments
          const environments = ['production', 'staging']

          for (const environment of environments) {
            const peripheryContracts = (networkData as any)[environment]
            if (Array.isArray(peripheryContracts)) {
              for (const contract of peripheryContracts) {
                if (contract.selectors && Array.isArray(contract.selectors)) {
                  for (const selectorObj of contract.selectors) {
                    if (
                      selectorObj.selector &&
                      typeof selectorObj.selector === 'string'
                    ) {
                      const selector = selectorObj.selector
                      if (selector.match(/^0x[a-fA-F0-9]{8}$/)) {
                        selectors.add(selector)
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    consola.success(
      `📄 Extracted ${selectors.size} selectors from whitelist.json (DEXS + PERIPHERY)`
    )
    return Array.from(selectors)
  } catch (error) {
    consola.error(`❌ Error reading whitelist.json:`, error)
    throw error // Re-throw to ensure the script fails if whitelist.json is missing
  }
}

function flattenAndSaveSelectors(
  existingData: ISelectorsDataFile,
  noScan = false
) {
  // Create a Set to automatically handle deduplication
  const uniqueSelectors = new Set<string>()

  if (!noScan) {
    // Iterate through all networks and add their selectors to the Set
    Object.values(existingData.networks).forEach((network) => {
      network.selectors.forEach((selector) => {
        uniqueSelectors.add(selector)
      })
    })
  }

  // Always add selectors from whitelist.json
  const whitelistSelectors = extractSelectorsFromWhitelist()
  whitelistSelectors.forEach((selector) => {
    uniqueSelectors.add(selector)
  })

  // Read and add selectors from sigs.json (deprecated)
  try {
    const whitelistedSelectorsPath = path.join(
      process.cwd(),
      'config',
      'sigs.json'
    )
    if (existsSync(whitelistedSelectorsPath)) {
      const whitelistedSelectors = JSON.parse(
        readFileSync(whitelistedSelectorsPath, 'utf-8')
      )
      whitelistedSelectors.selectors.forEach((selector: string) => {
        uniqueSelectors.add(selector)
      })
      consola.success(`📄 Added selectors from sigs.json (deprecated file)`)
    } else {
      consola.info(
        `ℹ️  sigs.json not found - skipping (this file is deprecated)`
      )
    }
  } catch (error) {
    consola.error(`❌ Error reading sigs.json:`, error)
  }

  // Read and add existing selectors from functionSelectorsToRemove.json (functionSelectorsToRemove)
  try {
    const functionSelectorsToRemovePath = path.join(
      process.cwd(),
      'config',
      'functionSelectorsToRemove.json'
    )
    if (existsSync(functionSelectorsToRemovePath)) {
      const functionSelectorsToRemoveData = JSON.parse(
        readFileSync(functionSelectorsToRemovePath, 'utf-8')
      )
      if (
        functionSelectorsToRemoveData.functionSelectorsToRemove &&
        Array.isArray(functionSelectorsToRemoveData.functionSelectorsToRemove)
      ) {
        functionSelectorsToRemoveData.functionSelectorsToRemove.forEach(
          (selector: string) => {
            uniqueSelectors.add(selector)
          }
        )
        consola.success(
          `📄 Added ${functionSelectorsToRemoveData.functionSelectorsToRemove.length} existing selectors from functionSelectorsToRemove.json`
        )
      }
    } else {
      consola.warn(
        `⚠️  functionSelectorsToRemove.json not found in config directory`
      )
    }
  } catch (error) {
    consola.error(`❌ Error reading functionSelectorsToRemove.json:`, error)
  }

  // Add special selectors just in case
  uniqueSelectors.add('0x00000000')
  uniqueSelectors.add('0xffffffff')
  consola.success(`📄 Added special selectors: 0x00000000, 0xffffffff`)

  // Convert Set to sorted array for consistent output
  const sortedSelectors = Array.from(uniqueSelectors).sort()

  // Create output object with the correct field name for functionSelectorsToRemove.json
  const output = {
    devNotes:
      '⚠️ AUTOMATICALLY GENERATED FILE ⚠️\n' +
      'This file is automatically generated by script/migration/scan-selector-approvals.ts\n' +
      'It contains a comprehensive list of function selectors gathered from:\n' +
      '- Historical blockchain events across all networks\n' +
      '- Selectors from whitelist.json (DEXS + PERIPHERY sections)\n' +
      '- Additional selectors from sigs.json (deprecated)\n\n' +
      'DO NOT MODIFY THIS FILE MANUALLY!\n' +
      'Instead, run scan-selector-approvals.ts to regenerate it with updated data.',
    functionSelectorsToRemove: sortedSelectors,
  }

  // Write to functionSelectorsToRemove.json
  const outputPath = path.join(
    process.cwd(),
    'config',
    'functionSelectorsToRemove.json'
  )
  writeFileSync(outputPath, JSON.stringify(output, null, 2))

  consola.success(`\n📄 Selectors summary:`)
  consola.info(`   Total unique selectors: ${sortedSelectors.length}`)
  consola.info(`   Output written to: ${outputPath}`)
}

// Define the command
const cmd = defineCommand({
  meta: {
    name: 'scan-selector-approvals',
    description:
      'Scan blockchain events in parallel to collect selector approvals, or use whitelist-only mode to extract selectors from configuration files',
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
        EnvironmentEnum.production,
      ],
    },
    deploymentBlocksFile: {
      type: 'string',
      description:
        'Deployment blocks config file (default: ./script/migration/scan-selector-approvals-config.json)',
      required: false,
      default: './script/migration/scan-selector-approvals-config.json',
    },
    maxConcurrency: {
      type: 'string',
      description:
        'Maximum number of networks to scan concurrently (default: 10)',
      required: false,
      default: '10',
    },
    noScan: {
      type: 'string',
      description:
        'Skip blockchain scanning and only use selectors from sigs.json and whitelist.json (DEXS + PERIPHERY)',
      required: false,
      default: 'false',
    },
  },
  async run({ args }) {
    const rpcUrlOverride = args?.rpcUrl
    const environment =
      args?.environment === EnvironmentEnum[EnvironmentEnum.staging]
        ? EnvironmentEnum.staging
        : EnvironmentEnum.production
    const tempOutputFile = './script/migration/tempFunctionSelectorsResult.json'
    const deploymentBlocksFile =
      args?.deploymentBlocksFile ||
      './script/migration/scan-selector-approvals-config.json'
    const maxConcurrency = parseInt(args?.maxConcurrency || '10')
    const noScan = args?.noScan === 'true'

    consola.info(`🚀 Starting function selectors preparation...`)
    consola.info(`🚀 No scan mode: ${noScan}`)
    if (noScan) {
      consola.info(`📄 NO-SCAN MODE: Skipping blockchain scanning`)
      consola.info(
        `📄 Will only use selectors from sigs.json and whitelist.json (DEXS + PERIPHERY)`
      )
    } else {
      consola.info(`📡 BLOCKCHAIN SCANNING MODE: Will scan blockchain events`)
    }
    consola.info(
      `📁 Temporary diagnostic file (for debugging): ${tempOutputFile}`
    )
    consola.info(
      `📁 Production config file (for deployment): config/functionSelectorsToRemove.json`
    )
    if (!noScan) {
      consola.info(`📁 Deployment blocks file: ${deploymentBlocksFile}`)
      consola.info(`🔧 Max concurrency: ${maxConcurrency}`)
    }
    consola.info(
      `🌍 Environment: ${
        environment === EnvironmentEnum.staging ? 'staging' : 'production'
      }`
    )

    // Load deployment blocks configuration
    let chunkConfigs: IChunkRangeConfig | undefined
    if (!noScan) {
      try {
        chunkConfigs = loadDeploymentBlocks(deploymentBlocksFile)
      } catch (error) {
        consola.error(`Failed to load chunk configurations: ${error}`)
        process.exit(1)
      }
    }

    // Load existing data if file exists (only in scanning mode)
    let existingData: ISelectorsDataFile = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      networks: {},
    }

    if (!noScan && existsSync(tempOutputFile)) {
      try {
        const fileContent = readFileSync(tempOutputFile, 'utf-8')
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

    // Determine which networks to scan (skip if whitelistOnly)
    const networksToScan: {
      network: INetworkConfig
      chunkConfig: IChunkConfig
    }[] = []

    if (!noScan) {
      if (args.network) {
        const networkName = args.network.toLowerCase()
        const networkConfig = (networksData as Record<string, INetworkConfig>)[
          networkName
        ]

        if (!networkConfig) {
          consola.error(`Network '${args.network}' not found in configuration`)
          process.exit(1)
        }

        const chunkConfig = chunkConfigs?.networks[networkName]
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
            const chunkConfig = chunkConfigs?.networks[networkName]
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

      consola.info(
        `📡 Will scan ${networksToScan.length} network(s) in parallel`
      )
    } else {
      consola.info(`📄 Skipping network scanning (no-scan mode)`)
    }

    // Process networks in batches with concurrency limit
    const results: IScanResult[] = []
    const startTime = Date.now()

    if (!noScan && networksToScan.length > 0) {
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
                writeFileSync(
                  tempOutputFile,
                  JSON.stringify(existingData, null, 2)
                )
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
    } else if (noScan) {
      consola.info(`📄 Skipping network processing (no-scan mode)`)
    }

    const totalTime = ((Date.now() - startTime) / 1000).toFixed(2)
    let summary: IScanSummary | undefined

    if (noScan) {
      // Skip summary generation and temp file writing in no-scan mode
      consola.success(`\n🎉 No-scan processing completed in ${totalTime}s!`)
      consola.info(`📊 PROCESSING SUMMARY:`)
      consola.info(`   Mode: No-scan (no blockchain scanning)`)
      consola.info(`   Processing time: ${totalTime}s`)
    } else {
      summary = generateSummary(results)

      // Final save
      writeFileSync(tempOutputFile, JSON.stringify(existingData, null, 2))

      consola.success(`\n🎉 Parallel scanning completed in ${totalTime}s!`)
      consola.info(`📊 SCAN SUMMARY:`)
      consola.info(`   Networks processed: ${summary.totalNetworks}`)
      consola.info(`   Successful scans: ${summary.successfulScans}`)
      consola.info(`   Failed scans: ${summary.failedScans}`)
      consola.info(`   Total selectors found: ${summary.totalSelectors}`)
      consola.info(`   Total scan time: ${summary.totalDuration.toFixed(2)}s`)

      if (summary.successfulScans > 0) {
        consola.success(
          `\n✅ SUCCESSFUL NETWORKS (${summary.successfulScans}):`
        )
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
    }

    // Add flattening step
    consola.info(`\n🔄 Flattening selectors from all sources...`)
    flattenAndSaveSelectors(existingData, noScan)

    process.exit(
      noScan ? 0 : summary?.failedScans && summary.failedScans > 0 ? 1 : 0
    )
  },
})

runMain(cmd)
