#!/usr/bin/env bun

/**
 * Check Periphery Contract Registration Per Network
 *
 * This script checks if a Periphery contract is registered in the diamond
 * (via PeripheryRegistryFacet) and whitelisted across all active networks.
 * It is only for Periphery contracts; use other tooling for facet registration checks.
 */

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import { consola } from 'consola'
import {
  createPublicClient,
  getAddress,
  http,
  parseAbi,
  type Address,
  type PublicClient,
} from 'viem'

import 'dotenv/config'

import globalConfig from '../../../config/global.json'
import networksConfig from '../../../config/networks.json'
import {
  EnvironmentEnum,
  type INetwork,
  type SupportedChain,
} from '../../common/types'
import { CachedDeploymentQuerier } from '../../deploy/shared/cached-deployment-querier'
import type { IConfig } from '../../deploy/shared/mongo-log-utils'
import { getDeployments } from '../../utils/deploymentHelpers'
import { getRPCEnvVarName } from '../../utils/network'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

// ABI for PeripheryRegistryFacet
const PERIPHERY_REGISTRY_ABI = parseAbi([
  'function getPeripheryContract(string) external view returns (address)',
])

// ABI for WhitelistManagerFacet
const WHITELIST_MANAGER_ABI = parseAbi([
  'function isContractSelectorWhitelisted(address,bytes4) external view returns (bool)',
  'function getWhitelistedSelectorsForContract(address) external view returns (bytes4[])',
])

interface IContractRegistrationStatus {
  network: string
  environment: 'production' | 'staging'
  inDeploymentLog: boolean | null // Contract exists in deployment JSON file
  onChainRegistered: boolean | null // Contract is registered on-chain in diamond
  isWhitelisted: boolean | null // For periphery: all selectors from global.json whitelistPeripheryFunctions whitelisted (or ≥1 if not in config)
  registeredAddress: string | null
  expectedAddress: string | null
  addressMatches: boolean | null
  /** Version from /// @custom:version in contract source */
  latestSourceVersion: string | null
  /** Latest deployment version/address from MongoDB for this contract+network */
  mongoLatestVersion: string | null
  mongoLatestAddress: string | null
  /** Version of the address currently registered on-chain (from MongoDB findByAddress) */
  onChainVersion: string | null
  /** MongoDB latest deployment version equals source @custom:version */
  versionMatchesSource: boolean | null
  /** On-chain registered address equals MongoDB latest deployment address */
  onChainAddressMatchesMongoLatest: boolean | null
  errors: string[]
}

/** Regex to extract /// @custom:version X.Y.Z from Solidity Natspec */
const CUSTOM_VERSION_REGEX = /@custom:version\s+([\d.]+)/

/**
 * Resolves contract source path for Periphery contracts only (src/Periphery).
 */
function getContractSourcePath(
  contractName: string,
  cwd: string
): string | null {
  const peripheryPath = join(cwd, 'src', 'Periphery', `${contractName}.sol`)
  if (existsSync(peripheryPath)) return peripheryPath
  return null
}

/**
 * Gets the latest contract version from /// @custom:version in the contract source
 */
function getLatestSourceVersion(contractName: string): string | null {
  const cwd = process.cwd()
  const sourcePath = getContractSourcePath(contractName, cwd)
  if (!sourcePath) return null
  try {
    const content = readFileSync(sourcePath, 'utf8')
    const match = content.match(CUSTOM_VERSION_REGEX)
    return match?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

/**
 * Checks if a periphery contract is registered
 */
async function checkPeripheryRegistration(
  publicClient: PublicClient,
  diamondAddress: Address,
  contractName: string
): Promise<{ isRegistered: boolean; registeredAddress: Address | null }> {
  try {
    const peripheryRegistry = {
      address: diamondAddress,
      abi: PERIPHERY_REGISTRY_ABI,
    }

    const registeredAddress = (await publicClient.readContract({
      ...peripheryRegistry,
      functionName: 'getPeripheryContract',
      args: [contractName],
    })) as Address

    if (
      registeredAddress &&
      registeredAddress !== '0x0000000000000000000000000000000000000000'
    ) {
      return {
        isRegistered: true,
        registeredAddress: getAddress(registeredAddress),
      }
    }

    return { isRegistered: false, registeredAddress: null }
  } catch (error) {
    throw new Error(
      `Failed to check periphery registration: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/** Expected periphery whitelist entries from config/global.json */
const whitelistPeripheryFunctions =
  (
    globalConfig as {
      whitelistPeripheryFunctions?: Record<
        string,
        Array<{ selector: string; signature?: string }>
      >
    }
  ).whitelistPeripheryFunctions ?? {}

/**
 * Checks if a periphery contract is whitelisted for use by the Diamond.
 * Uses config/global.json whitelistPeripheryFunctions[contractName]: if present,
 * every listed selector must be whitelisted on-chain. If the contract is not in
 * config, falls back to "at least one selector" whitelisted.
 */
async function checkPeripheryWhitelist(
  publicClient: PublicClient,
  diamondAddress: Address,
  contractAddress: Address,
  contractName: string
): Promise<boolean> {
  const whitelistManager = {
    address: diamondAddress,
    abi: WHITELIST_MANAGER_ABI,
  }

  const expectedEntries = whitelistPeripheryFunctions[contractName]

  if (expectedEntries && expectedEntries.length > 0) {
    for (const entry of expectedEntries) {
      const selector = entry.selector.startsWith('0x')
        ? (entry.selector as `0x${string}`)
        : (`0x${entry.selector}` as `0x${string}`)
      const isWhitelisted = (await publicClient.readContract({
        ...whitelistManager,
        functionName: 'isContractSelectorWhitelisted',
        args: [contractAddress, selector],
      })) as boolean
      if (!isWhitelisted) return false
    }
    return true
  }

  const whitelistedSelectors = (await publicClient.readContract({
    ...whitelistManager,
    functionName: 'getWhitelistedSelectorsForContract',
    args: [contractAddress],
  })) as readonly `0x${string}`[]
  return Array.isArray(whitelistedSelectors) && whitelistedSelectors.length > 0
}

/**
 * Checks contract registration status for a single network
 */
async function checkNetworkContractRegistration(
  networkName: SupportedChain,
  networkConfig: INetwork,
  environment: 'production' | 'staging',
  contractName: string
): Promise<IContractRegistrationStatus> {
  const status: IContractRegistrationStatus = {
    network: networkName,
    environment,
    inDeploymentLog: null,
    onChainRegistered: null,
    isWhitelisted: null,
    registeredAddress: null,
    expectedAddress: null,
    addressMatches: null,
    latestSourceVersion: null,
    mongoLatestVersion: null,
    mongoLatestAddress: null,
    onChainVersion: null,
    versionMatchesSource: null,
    onChainAddressMatchesMongoLatest: null,
    errors: [],
  }

  try {
    // Get deployments
    const environmentEnum =
      environment === 'production'
        ? EnvironmentEnum.production
        : EnvironmentEnum.staging

    let deployments: Record<string, string>
    try {
      const deploymentsModule = await getDeployments(
        networkName,
        environmentEnum
      )
      // JSON imports might return default export or direct object
      deployments =
        (deploymentsModule as { default?: Record<string, string> }).default ||
        (deploymentsModule as Record<string, string>)
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      status.errors.push(`Failed to load deployments: ${errorMessage}`)
      return status
    }

    if (!deployments || typeof deployments !== 'object') {
      status.errors.push('Invalid deployments data')
      return status
    }

    const diamondAddress = deployments.LiFiDiamond
      ? (getAddress(deployments.LiFiDiamond) as Address)
      : undefined

    if (!diamondAddress) {
      status.errors.push('LiFiDiamond not deployed')
      return status
    }

    // Check if contract exists in deployment log
    const expectedAddress = deployments[contractName]
      ? (getAddress(deployments[contractName]) as Address)
      : undefined
    status.inDeploymentLog = expectedAddress !== undefined
    status.expectedAddress = expectedAddress || null

    // If contract is not in deployment log, we can't check on-chain registration
    if (!status.inDeploymentLog) {
      status.onChainRegistered = false
      return status
    }

    // Get RPC URL: prefer env (getRPCEnvVarName), then networks.json, then viem chain default
    const chain = getViemChainForNetworkName(networkName)
    const rpcEnvVarName = getRPCEnvVarName(networkName)
    const rpcUrl =
      process.env[rpcEnvVarName] ||
      networkConfig.rpcUrl ||
      chain.rpcUrls.default.http[0]

    if (!rpcUrl) {
      status.errors.push('No RPC URL available')
      return status
    }

    // Create public client
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    // Check periphery registration via PeripheryRegistryFacet
    const registrationResult = await checkPeripheryRegistration(
      publicClient,
      diamondAddress,
      contractName
    )

    status.onChainRegistered = registrationResult.isRegistered
    status.registeredAddress = registrationResult.registeredAddress

    // Check if addresses match
    if (
      status.onChainRegistered &&
      status.registeredAddress &&
      status.expectedAddress
    ) {
      status.addressMatches =
        getAddress(status.registeredAddress) ===
        getAddress(status.expectedAddress)
    }

    // Check if periphery contract is correctly whitelisted
    if (status.onChainRegistered && status.registeredAddress) {
      try {
        const registeredAddr = getAddress(status.registeredAddress) as Address
        status.isWhitelisted = await checkPeripheryWhitelist(
          publicClient,
          diamondAddress,
          registeredAddr,
          contractName
        )
      } catch (error) {
        // If whitelist check fails, mark as null (unknown)
        status.isWhitelisted = null
        status.errors.push(
          `Failed to check whitelist: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  } catch (error) {
    status.errors.push(error instanceof Error ? error.message : String(error))
  }

  return status
}

/**
 * Main function
 */
async function main() {
  const args = process.argv.slice(2)

  if (args.length < 1) {
    consola.error(
      'Usage: bun checkContractRegistrationPerNetwork.ts <PERIPHERY_CONTRACT_NAME> [environment]'
    )
    consola.error(
      'Example: bun checkContractRegistrationPerNetwork.ts Executor'
    )
    consola.error(
      'Example: bun checkContractRegistrationPerNetwork.ts Executor staging'
    )
    consola.error(
      'This script is only for Periphery contracts (e.g. Executor, ReceiverV2).'
    )
    process.exit(1)
  }

  const contractName = args[0]
  if (!contractName) {
    consola.error('Periphery contract name is required')
    process.exit(1)
  }

  const cwd = process.cwd()
  const peripheryPath = join(cwd, 'src', 'Periphery', `${contractName}.sol`)
  if (!existsSync(peripheryPath)) {
    consola.error(
      `This script is only for Periphery contracts. "${contractName}" was not found in src/Periphery (expected: src/Periphery/${contractName}.sol).`
    )
    process.exit(1)
  }

  const environment = (args[1] as 'production' | 'staging') || 'production'

  consola.info(
    `Checking Periphery registration for ${contractName} on all networks...`
  )
  consola.info(`Environment: ${environment}`)

  const networks = networksConfig as Record<string, Partial<INetwork>>
  const results: IContractRegistrationStatus[] = []

  // Filter to only valid SupportedChain networks
  const validNetworkNames = Object.keys(networks).filter(
    (name): name is SupportedChain => name in networks
  )

  // Excluded networks (non-EVM chains that don't support standard checks)
  const EXCLUDED_NETWORKS = ['tron', 'tronshasta']

  // Process networks in parallel
  const networkNames = validNetworkNames.filter(
    (name) =>
      networks[name]?.status === 'active' && !EXCLUDED_NETWORKS.includes(name)
  )

  consola.info(
    `Checking ${networkNames.length} active networks (${
      EXCLUDED_NETWORKS.length
    } excluded: ${EXCLUDED_NETWORKS.join(', ')})...`
  )

  // Process all networks in parallel
  const networkResults = await Promise.all(
    networkNames.map((networkName) => {
      const networkConfig = networks[networkName]
      if (!networkConfig) {
        const errorStatus: IContractRegistrationStatus = {
          network: networkName,
          environment,
          inDeploymentLog: null,
          onChainRegistered: null,
          isWhitelisted: null,
          registeredAddress: null,
          expectedAddress: null,
          addressMatches: null,
          latestSourceVersion: null,
          mongoLatestVersion: null,
          mongoLatestAddress: null,
          onChainVersion: null,
          versionMatchesSource: null,
          onChainAddressMatchesMongoLatest: null,
          errors: ['Network config not found'],
        }
        return errorStatus
      }
      return checkNetworkContractRegistration(
        networkName as SupportedChain,
        networkConfig as INetwork,
        environment,
        contractName
      )
    })
  )

  results.push(...networkResults)

  // Resolve latest source version from /// @custom:version in contract source
  const latestSourceVersion = getLatestSourceVersion(contractName)
  for (const r of results) {
    r.latestSourceVersion = latestSourceVersion
  }

  // Enrich with MongoDB deployment log (version + address) when MONGODB_URI is set
  const mongoUri = process.env.MONGODB_URI
  if (mongoUri) {
    const mongoConfig: IConfig = {
      mongoUri,
      batchSize: 100,
      databaseName: 'contract-deployments',
    }
    try {
      const cachedQuerier = new CachedDeploymentQuerier(
        mongoConfig,
        environment as keyof typeof EnvironmentEnum
      )
      for (const r of results) {
        try {
          const mongoLatest = await cachedQuerier.getLatestDeployment(
            contractName,
            r.network
          )
          if (mongoLatest) {
            r.mongoLatestVersion = mongoLatest.version
            r.mongoLatestAddress = mongoLatest.address
            r.versionMatchesSource =
              latestSourceVersion !== null &&
              mongoLatest.version === latestSourceVersion
            r.onChainAddressMatchesMongoLatest =
              r.registeredAddress !== null &&
              getAddress(r.registeredAddress) ===
                getAddress(mongoLatest.address)
          }
          if (r.registeredAddress) {
            const onChainRecord = await cachedQuerier.findByAddress(
              r.registeredAddress,
              r.network
            )
            r.onChainVersion = onChainRecord?.version ?? null
          }
        } catch (err) {
          r.errors.push(
            `Mongo version check: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      }
    } catch (err) {
      consola.warn(
        'MongoDB version check skipped:',
        err instanceof Error ? err.message : String(err)
      )
    }
  }

  // Sort results: both checks pass first, then by network name
  results.sort((a, b) => {
    const aBoth = a.inDeploymentLog === true && a.onChainRegistered === true
    const bBoth = b.inDeploymentLog === true && b.onChainRegistered === true
    if (aBoth === bBoth) {
      return a.network.localeCompare(b.network)
    }
    return aBoth ? -1 : 1
  })

  // Display results in column format
  consola.info('\n' + '='.repeat(100))
  consola.info('PERIPHERY CONTRACT REGISTRATION STATUS SUMMARY')
  consola.info('='.repeat(100) + '\n')

  const sourceVersion =
    results[0]?.latestSourceVersion ?? getLatestSourceVersion(contractName)
  if (sourceVersion) {
    consola.info(`Source version (/// @custom:version): ${sourceVersion}`)
  } else {
    consola.info('Source version: N/A (no @custom:version in Periphery source)')
  }
  consola.info('')

  // This script is only for Periphery contracts; always show whitelist column
  const isPeripheryContract = true

  // Version column widths
  const verCol = 8 // Source / Mongo / On-Chain version
  const latestCol = 8 // Latest? (✅/❌/—)
  const versionHeader = ` ${'Src'.padEnd(verCol)} ${'Mongo'.padEnd(
    verCol
  )} ${'OnCh'.padEnd(verCol)} ${'Latest?'.padEnd(latestCol)}`

  // Print header
  const header = isPeripheryContract
    ? `${'Network'.padEnd(20)} ${'Environment'.padEnd(
        12
      )} ${'In Deployment Log'.padEnd(20)} ${'On-Chain Registered'.padEnd(
        20
      )} ${'Whitelisted'.padEnd(15)}${versionHeader} ${'Status'.padEnd(15)}`
    : `${'Network'.padEnd(20)} ${'Environment'.padEnd(
        12
      )} ${'In Deployment Log'.padEnd(20)} ${'On-Chain Registered'.padEnd(
        20
      )}${versionHeader} ${'Status'.padEnd(15)}`
  consola.info(header)
  const headerLen = isPeripheryContract
    ? 120 + versionHeader.length
    : 100 + versionHeader.length
  consola.info('-'.repeat(headerLen))

  // Categorize results
  const bothPass = results.filter(
    (r) =>
      r.inDeploymentLog === true &&
      r.onChainRegistered === true &&
      (!isPeripheryContract || r.isWhitelisted === true)
  )
  const inLogNotOnChain = results.filter(
    (r) => r.inDeploymentLog === true && r.onChainRegistered === false
  )
  const notWhitelisted = isPeripheryContract
    ? results.filter(
        (r) =>
          r.inDeploymentLog === true &&
          r.onChainRegistered === true &&
          r.isWhitelisted === false
      )
    : []
  const notInLog = results.filter((r) => r.inDeploymentLog === false)
  const errors = results.filter((r) => r.errors.length > 0)

  // Display results
  for (const result of results) {
    const networkName = `${result.network} (${result.environment})`.padEnd(32)
    const inLogStatus =
      result.inDeploymentLog === true
        ? '✅ Yes'
        : result.inDeploymentLog === false
        ? '❌ No'
        : '❓ Unknown'
    const onChainStatus =
      result.onChainRegistered === true
        ? '✅ Yes'
        : result.onChainRegistered === false
        ? '❌ No'
        : '❓ Unknown'

    // Whitelist status (only for periphery contracts)
    const whitelistStatus = isPeripheryContract
      ? result.isWhitelisted === true
        ? '✅ Yes'
        : result.isWhitelisted === false
        ? '❌ No'
        : '❓ Unknown'
      : 'N/A'

    // Version columns (from source @custom:version and MongoDB)
    const srcVer = (result.latestSourceVersion ?? '—')
      .slice(0, verCol)
      .padEnd(verCol)
    const mongoVer = (result.mongoLatestVersion ?? '—')
      .slice(0, verCol)
      .padEnd(verCol)
    const onChainVer = (result.onChainVersion ?? '—')
      .slice(0, verCol)
      .padEnd(verCol)
    const isLatest =
      result.versionMatchesSource === true &&
      result.onChainAddressMatchesMongoLatest === true
    const latestStatus =
      result.mongoLatestVersion !== undefined &&
      result.mongoLatestVersion !== null
        ? isLatest
          ? '✅ Yes'.padEnd(latestCol)
          : '❌ No'.padEnd(latestCol)
        : '—'.padEnd(latestCol)
    const versionBlock = ` ${srcVer} ${mongoVer} ${onChainVer} ${latestStatus}`

    let status = ''
    if (result.errors.length > 0) {
      status = '⚠️ Error'
    } else if (
      result.inDeploymentLog === true &&
      result.onChainRegistered === true
    ) {
      // For periphery contracts, also check whitelist
      if (isPeripheryContract && result.isWhitelisted === false) {
        status = '⚠️ Not Whitelisted'
      } else if (result.addressMatches === false) {
        status = '⚠️ Address Mismatch'
      } else if (
        result.versionMatchesSource === false ||
        result.onChainAddressMatchesMongoLatest === false
      ) {
        status = '⚠️ Outdated (not latest version)'
      } else {
        status = '✅ OK'
      }
    } else if (
      result.inDeploymentLog === true &&
      result.onChainRegistered === false
    ) {
      status = '⚠️ Not Registered'
    } else if (result.inDeploymentLog === false) {
      status = '❌ Not Deployed'
    } else {
      status = '❓ Unknown'
    }

    if (isPeripheryContract) {
      consola.info(
        `${networkName} ${inLogStatus.padEnd(20)} ${onChainStatus.padEnd(
          20
        )} ${whitelistStatus.padEnd(15)}${versionBlock} ${status}`
      )
    } else {
      consola.info(
        `${networkName} ${inLogStatus.padEnd(20)} ${onChainStatus.padEnd(
          20
        )}${versionBlock} ${status}`
      )
    }

    // Show address mismatch details
    if (
      result.addressMatches === false &&
      result.registeredAddress &&
      result.expectedAddress
    ) {
      consola.warn(
        `    └─ Address mismatch: registered=${result.registeredAddress}, expected=${result.expectedAddress}`
      )
    }
    // Show version mismatch when on-chain is not latest
    if (
      result.onChainAddressMatchesMongoLatest === false &&
      result.mongoLatestAddress &&
      result.registeredAddress
    ) {
      consola.warn(
        `    └─ Version: on-chain=${result.onChainVersion ?? '?'} @ ${
          result.registeredAddress
        }, Mongo latest=${result.mongoLatestVersion} @ ${
          result.mongoLatestAddress
        }`
      )
    }

    // Show errors
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        consola.warn(`    └─ ${error}`)
      }
    }
  }

  const versionLatestCount = results.filter(
    (r) =>
      r.versionMatchesSource === true &&
      r.onChainAddressMatchesMongoLatest === true
  ).length
  const versionOutdatedCount = results.filter(
    (r) =>
      r.mongoLatestVersion !== undefined &&
      r.mongoLatestVersion !== null &&
      (r.versionMatchesSource === false ||
        r.onChainAddressMatchesMongoLatest === false)
  ).length

  const separator = Math.max(isPeripheryContract ? 120 : 100, headerLen ?? 140)
  consola.info('\n' + '='.repeat(separator))
  consola.info('SUMMARY:')
  consola.info(`  ✅ All checks pass: ${bothPass.length} networks`)
  consola.info(
    `  ⚠️  In log but not on-chain: ${inLogNotOnChain.length} networks`
  )
  if (isPeripheryContract) {
    consola.info(
      `  ⚠️  Registered but not whitelisted: ${notWhitelisted.length} networks`
    )
  }
  if (sourceVersion) {
    consola.info(
      `  📦 Version: matches source & Mongo latest: ${versionLatestCount} networks`
    )
    consola.info(
      `  📦 Version: outdated (on-chain ≠ latest): ${versionOutdatedCount} networks`
    )
  }
  consola.info(`  ❌ Not in deployment log: ${notInLog.length} networks`)
  consola.info(`  ⚠️  Errors: ${errors.length} networks`)
  consola.info(`  Total: ${results.length} networks`)
  consola.info('='.repeat(separator) + '\n')

  // Exit with error code if any networks have issues
  if (
    inLogNotOnChain.length > 0 ||
    notInLog.length > 0 ||
    (isPeripheryContract && notWhitelisted.length > 0) ||
    errors.length > 0
  ) {
    process.exit(1)
  }
}

// Run main function
main().catch((error) => {
  consola.error('Fatal error:', error)
  process.exit(1)
})
