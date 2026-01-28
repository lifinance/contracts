#!/usr/bin/env bun

/**
 * Check Contract Registration Per Network
 *
 * This script checks if a contract (facet or periphery) is registered in the diamond
 * across all active networks. For facets, it checks if the facet is registered.
 * For periphery contracts, it checks if they're registered via PeripheryRegistryFacet.
 */

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

import networksConfig from '../../../config/networks.json'
import {
  EnvironmentEnum,
  type INetwork,
  type SupportedChain,
} from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

// ABI for Diamond Loupe (to check facet registration)
const DIAMOND_LOUPE_ABI = parseAbi([
  'function facetAddress(bytes4) view returns (address)',
  'function facets() view returns ((address,bytes4[])[])',
])

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
  isWhitelisted: boolean | null // For periphery: all selectors are whitelisted
  registeredAddress: string | null
  expectedAddress: string | null
  addressMatches: boolean | null
  errors: string[]
}

/**
 * Gets function selectors for a facet contract
 */
async function getFacetSelectors(
  contractName: string
): Promise<`0x${string}`[]> {
  try {
    const { execSync } = await import('child_process')
    const { readFileSync } = await import('fs')
    const { join } = await import('path')

    // Try to get ABI from out directory
    const abiPath = join(
      process.cwd(),
      'out',
      `${contractName}.sol`,
      `${contractName}.json`
    )

    if (!readFileSync(abiPath, 'utf8')) {
      throw new Error(`ABI file not found: ${abiPath}`)
    }

    const artifact = JSON.parse(readFileSync(abiPath, 'utf8'))
    const abi = artifact.abi

    if (!abi) {
      throw new Error(`No ABI found in artifact for ${contractName}`)
    }

    // Extract function selectors from ABI
    const selectors: `0x${string}`[] = []
    for (const item of abi) {
      if (item.type === 'function' && item.name) {
        // Calculate function selector
        const signature = `${item.name}(${item.inputs
          .map((input: { type: string }) => input.type)
          .join(',')})`
        const selector = execSync(`cast sig "${signature}"`, {
          encoding: 'utf8',
        })
          .trim()
          .slice(0, 10) as `0x${string}`
        selectors.push(selector)
      }
    }

    return selectors
  } catch (error) {
    consola.warn(
      `Could not get selectors for ${contractName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return []
  }
}

/**
 * Checks if a facet is registered in the diamond by verifying ALL selectors are attached
 */
async function checkFacetRegistration(
  publicClient: PublicClient,
  diamondAddress: Address,
  contractName: string
): Promise<{ isRegistered: boolean; registeredAddress: Address | null }> {
  try {
    const selectors = await getFacetSelectors(contractName)

    if (selectors.length === 0) {
      return { isRegistered: false, registeredAddress: null }
    }

    // Check if ALL selectors are registered (not just one)
    const diamond = {
      address: diamondAddress,
      abi: DIAMOND_LOUPE_ABI,
    }

    let registeredAddress: Address | null = null
    let allSelectorsRegistered = true

    for (const selector of selectors) {
      try {
        const facetAddress = (await publicClient.readContract({
          ...diamond,
          functionName: 'facetAddress',
          args: [selector],
        })) as Address

        if (
          facetAddress &&
          facetAddress !== '0x0000000000000000000000000000000000000000'
        ) {
          // Store the first valid address we find
          if (!registeredAddress) {
            registeredAddress = facetAddress
          }
          // Verify all selectors point to the same address
          if (getAddress(facetAddress) !== getAddress(registeredAddress)) {
            allSelectorsRegistered = false
            break
          }
        } else {
          // Selector not registered
          allSelectorsRegistered = false
          break
        }
      } catch (error) {
        // Selector check failed
        allSelectorsRegistered = false
        break
      }
    }

    return {
      isRegistered: allSelectorsRegistered,
      registeredAddress: allSelectorsRegistered ? registeredAddress : null,
    }
  } catch (error) {
    throw new Error(
      `Failed to check facet registration: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
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

/**
 * Checks if a periphery contract is correctly whitelisted by verifying all selectors
 */
async function checkPeripheryWhitelist(
  publicClient: PublicClient,
  diamondAddress: Address,
  contractAddress: Address,
  contractName: string
): Promise<boolean> {
  try {
    // Get all function selectors from the contract ABI
    const selectors = await getFacetSelectors(contractName)

    if (selectors.length === 0) {
      // If we can't get selectors, we can't verify whitelist
      return false
    }

    // Check if WhitelistManagerFacet is available
    const whitelistManager = {
      address: diamondAddress,
      abi: WHITELIST_MANAGER_ABI,
    }

    // Check if ALL selectors are whitelisted
    for (const selector of selectors) {
      try {
        const isWhitelisted = (await publicClient.readContract({
          ...whitelistManager,
          functionName: 'isContractSelectorWhitelisted',
          args: [contractAddress, selector],
        })) as boolean

        if (!isWhitelisted) {
          // At least one selector is not whitelisted
          return false
        }
      } catch (error) {
        // If call fails, assume not whitelisted
        return false
      }
    }

    // All selectors are whitelisted
    return true
  } catch (error) {
    // If we can't check, return false
    return false
  }
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

    // Get RPC URL
    const chain = getViemChainForNetworkName(networkName)
    const rpcUrl = networkConfig.rpcUrl || chain.rpcUrls.default.http[0]

    if (!rpcUrl) {
      status.errors.push('No RPC URL available')
      return status
    }

    // Create public client
    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    })

    // Determine if it's a facet or periphery
    const isFacet = contractName.includes('Facet')

    let registrationResult: {
      isRegistered: boolean
      registeredAddress: Address | null
    }

    if (isFacet) {
      registrationResult = await checkFacetRegistration(
        publicClient,
        diamondAddress,
        contractName
      )
    } else {
      registrationResult = await checkPeripheryRegistration(
        publicClient,
        diamondAddress,
        contractName
      )
    }

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

    // For periphery contracts, check if they're correctly whitelisted
    if (!isFacet && status.onChainRegistered && status.registeredAddress) {
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
      'Usage: bun checkContractRegistrationPerNetwork.ts <CONTRACT_NAME> [environment]'
    )
    consola.error(
      'Example: bun checkContractRegistrationPerNetwork.ts StargateFacet'
    )
    consola.error(
      'Example: bun checkContractRegistrationPerNetwork.ts Executor staging'
    )
    process.exit(1)
  }

  const contractName = args[0]
  if (!contractName) {
    consola.error('Contract name is required')
    process.exit(1)
  }
  const environment = (args[1] as 'production' | 'staging') || 'production'

  consola.info(`Checking registration for ${contractName} on all networks...`)
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
  consola.info('CONTRACT REGISTRATION STATUS SUMMARY')
  consola.info('='.repeat(100) + '\n')

  // Determine if this is a periphery contract (to show whitelist column)
  const isPeripheryContract = !contractName.includes('Facet')

  // Print header
  const header = isPeripheryContract
    ? `${'Network'.padEnd(20)} ${'Environment'.padEnd(
        12
      )} ${'In Deployment Log'.padEnd(20)} ${'On-Chain Registered'.padEnd(
        20
      )} ${'Whitelisted'.padEnd(15)} ${'Status'.padEnd(15)}`
    : `${'Network'.padEnd(20)} ${'Environment'.padEnd(
        12
      )} ${'In Deployment Log'.padEnd(20)} ${'On-Chain Registered'.padEnd(
        20
      )} ${'Status'.padEnd(15)}`
  consola.info(header)
  consola.info('-'.repeat(isPeripheryContract ? 120 : 100))

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
        )} ${whitelistStatus.padEnd(15)} ${status}`
      )
    } else {
      consola.info(
        `${networkName} ${inLogStatus.padEnd(20)} ${onChainStatus.padEnd(
          20
        )} ${status}`
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

    // Show errors
    if (result.errors.length > 0) {
      for (const error of result.errors) {
        consola.warn(`    └─ ${error}`)
      }
    }
  }

  const separator = isPeripheryContract ? 120 : 100
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
