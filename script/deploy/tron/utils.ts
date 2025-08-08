import { resolve } from 'path'

import { consola } from 'consola'

import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import { getEnvVar } from '../../demoScripts/utils/demoScriptHelpers'

import type { IForgeArtifact } from './types'

// Constants
export const ENERGY_PRICE = 0.00021 // TRX per energy unit
export const BANDWIDTH_PRICE = 0.001 // TRX per bandwidth point
export const DEFAULT_SAFETY_MARGIN = 1.5 // 50% buffer

/**
 * Load compiled contract artifact from Forge output
 */
export async function loadForgeArtifact(
  contractName: string
): Promise<IForgeArtifact> {
  const artifactPath = resolve(
    process.cwd(),
    `out/${contractName}.sol/${contractName}.json`
  )

  try {
    const artifact = await Bun.file(artifactPath).json()

    if (!artifact.abi || !artifact.bytecode?.object)
      throw new Error(
        `Invalid artifact for ${contractName}: missing ABI or bytecode`
      )

    consola.info(`Loaded ${contractName} from: ${artifactPath}`)
    return artifact
  } catch (error: any) {
    throw new Error(`Failed to load ${contractName} artifact: ${error.message}`)
  }
}

/**
 * Get core facets list from config/global.json
 */
export function getCoreFacets(): string[] {
  return (globalConfig as any).coreFacets || []
}

/**
 * Execute shell command
 */
export async function executeShellCommand(command: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-c', command], {
    cwd: process.cwd(),
    env: process.env,
  })

  const output = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  if (exitCode !== 0)
    throw new Error(`Command failed with exit code ${exitCode}: ${command}`)

  return output.trim()
}

/**
 * Get deployment environment from config.sh
 */
export async function getEnvironment(): Promise<string> {
  const productionValue = await executeShellCommand(
    'source script/config.sh && echo $PRODUCTION'
  )
  return productionValue === 'true' ? 'production' : 'staging'
}

/**
 * Get the correct private key based on environment
 */
export async function getPrivateKey(): Promise<string> {
  const environment = await getEnvironment()

  if (environment === 'production') return getEnvVar('PRIVATE_KEY_PRODUCTION')
  else return getEnvVar('PRIVATE_KEY')
}

/**
 * Log deployment using existing helperFunctions.sh
 */
export async function logDeployment(
  contract: string,
  network: string,
  address: string,
  version: string,
  constructorArgs: string,
  verified = false
): Promise<void> {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const environment = await getEnvironment()

  const logCommand = `source script/config.sh && source script/helperFunctions.sh && logContractDeploymentInfo "${contract}" "${network}" "${timestamp}" "${version}" "200" "${constructorArgs}" "${environment}" "${address}" "${verified}" "" "0.8.17" "london" ""`

  await executeShellCommand(logCommand)
}

/**
 * Save contract address to deployments file
 */
export async function saveContractAddress(
  network: string,
  contract: string,
  address: string
): Promise<void> {
  const environment = await getEnvironment()
  const fileSuffix = environment === 'production' ? '' : 'staging.'
  const deploymentFile = resolve(
    process.cwd(),
    `deployments/${network}.${fileSuffix}json`
  )

  let deployments: Record<string, string> = {}

  try {
    const existing = await Bun.file(deploymentFile).json()
    deployments = existing
  } catch {
    // File doesn't exist, start fresh
  }

  deployments[contract] = address

  await Bun.write(deploymentFile, JSON.stringify(deployments, null, 2))
}

/**
 * Get contract address from deployments file
 */
export async function getContractAddress(
  network: string,
  contract: string
): Promise<string | null> {
  const environment = await getEnvironment()
  const fileSuffix = environment === 'production' ? '' : 'staging.'
  const deploymentFile = resolve(
    process.cwd(),
    `deployments/${network}.${fileSuffix}json`
  )

  try {
    const deployments = await Bun.file(deploymentFile).json()
    return deployments[contract] || null
  } catch {
    // File doesn't exist or can't be read
    return null
  }
}

/**
 * Save diamond deployment information
 */
export async function saveDiamondDeployment(
  network: string,
  _diamondAddress: string,
  facets: Record<string, { address: string; version: string }>
): Promise<void> {
  const environment = await getEnvironment()
  const fileSuffix = environment === 'production' ? '' : 'staging.'
  const diamondFile = resolve(
    process.cwd(),
    `deployments/${network}.diamond.${fileSuffix}json`
  )

  const diamondData = {
    LiFiDiamond: {
      Facets: {} as Record<string, { Name: string; Version: string }>,
      Periphery: {} as Record<string, string>,
    },
  }

  // Add facets with address as key
  for (const [facetName, facetInfo] of Object.entries(facets))
    diamondData.LiFiDiamond.Facets[facetInfo.address] = {
      Name: facetName,
      Version: facetInfo.version,
    }

  await Bun.write(diamondFile, JSON.stringify(diamondData, null, 2))
}

/**
 * Get network configuration from config/networks.json
 */
export function getNetworkConfig(networkName: string): any {
  const networkConfig = (networks as any)[networkName]
  if (!networkConfig)
    throw new Error(`Network configuration not found for: ${networkName}`)

  return networkConfig
}

/**
 * Get contract version from source file
 */
export async function getContractVersion(
  contractName: string
): Promise<string> {
  const possiblePaths = [
    `src/${contractName}.sol`,
    `src/Facets/${contractName}.sol`,
    `src/Periphery/${contractName}.sol`,
  ]

  for (const path of possiblePaths) {
    const fullPath = resolve(process.cwd(), path)
    try {
      const content = await Bun.file(fullPath).text()
      const versionMatch = content.match(/@custom:version\s+(\S+)/)
      if (versionMatch && versionMatch[1]) return versionMatch[1]
    } catch {
      // Try next path
    }
  }

  throw new Error(`Could not find version for ${contractName}`)
}

/**
 * Calculate transaction bandwidth
 */
export function calculateTransactionBandwidth(transaction: any): number {
  const DATA_HEX_PROTOBUF_EXTRA = 3
  const MAX_RESULT_SIZE_IN_TX = 64
  const A_SIGNATURE = 67

  const rawDataLength = transaction.raw_data_hex
    ? transaction.raw_data_hex.length / 2
    : JSON.stringify(transaction.raw_data).length

  const signatureCount = transaction.signature?.length || 1

  return (
    rawDataLength +
    DATA_HEX_PROTOBUF_EXTRA +
    MAX_RESULT_SIZE_IN_TX +
    signatureCount * A_SIGNATURE
  )
}

/**
 * Update tron.diamond.json with registered facet information
 * @param facetAddress - The Tron address of the facet (base58 format)
 * @param facetName - The name of the facet (e.g., 'SymbiosisFacet')
 * @param version - The version of the facet (optional, will try to get from contract)
 */
export async function updateDiamondJson(
  facetAddress: string,
  facetName: string,
  version?: string
): Promise<void> {
  try {
    const diamondJsonPath = resolve(
      process.cwd(),
      'deployments',
      'tron.diamond.json'
    )

    // Read existing file or create new structure
    let diamondData: any
    try {
      const fileContent = await Bun.file(diamondJsonPath).text()
      diamondData = JSON.parse(fileContent)
    } catch {
      // File doesn't exist or is invalid, create new structure
      diamondData = {
        LiFiDiamond: {
          Facets: {},
          Periphery: {},
        },
      }
    }

    // Ensure structure exists
    if (!diamondData.LiFiDiamond)
      diamondData.LiFiDiamond = {
        Facets: {},
        Periphery: {},
      }

    if (!diamondData.LiFiDiamond.Facets) diamondData.LiFiDiamond.Facets = {}

    // Check if facet already exists (by name to avoid duplicates)
    const facets = diamondData.LiFiDiamond.Facets

    for (const address in facets)
      if (facets[address].Name === facetName)
        if (address === facetAddress) {
          consola.info(`ℹ️  ${facetName} already exists in tron.diamond.json`)
          return
        } else {
          // Same facet name but different address - update it
          consola.info(`ℹ️  Updating ${facetName} address in tron.diamond.json`)
          delete facets[address]
          break
        }

    // Get version if not provided
    if (!version)
      try {
        version = await getContractVersion(facetName)
      } catch {
        version = '1.0.0' // Default version if not found
        consola.warn(
          `⚠️  Could not determine version for ${facetName}, using default: ${version}`
        )
      }

    // Add facet entry
    facets[facetAddress] = {
      Name: facetName,
      Version: version,
    }

    // Write updated file
    await Bun.write(
      diamondJsonPath,
      JSON.stringify(diamondData, null, 2) + '\n'
    )

    consola.success(`✅ Updated tron.diamond.json with ${facetName}`)
  } catch (error: any) {
    consola.error('❌ Failed to update tron.diamond.json:', error.message)
    // Don't throw - this is not critical for the deployment
  }
}

/**
 * Update tron.diamond.json with multiple facets at once
 * @param facetEntries - Array of {address, name, version?} objects
 */
export async function updateDiamondJsonBatch(
  facetEntries: Array<{
    address: string
    name: string
    version?: string
  }>
): Promise<void> {
  try {
    const diamondJsonPath = resolve(
      process.cwd(),
      'deployments',
      'tron.diamond.json'
    )

    // Read existing file or create new structure
    let diamondData: any
    try {
      const fileContent = await Bun.file(diamondJsonPath).text()
      diamondData = JSON.parse(fileContent)
    } catch {
      diamondData = {
        LiFiDiamond: {
          Facets: {},
          Periphery: {},
        },
      }
    }

    // Ensure structure exists
    if (!diamondData.LiFiDiamond)
      diamondData.LiFiDiamond = {
        Facets: {},
        Periphery: {},
      }

    if (!diamondData.LiFiDiamond.Facets) diamondData.LiFiDiamond.Facets = {}

    const facets = diamondData.LiFiDiamond.Facets
    let updatedCount = 0

    // Process each facet entry
    for (const entry of facetEntries) {
      // Check if facet already exists by name
      let existingAddress: string | null = null
      for (const address in facets)
        if (facets[address].Name === entry.name) {
          existingAddress = address
          break
        }

      if (existingAddress === entry.address) {
        consola.info(`ℹ️  ${entry.name} already exists in tron.diamond.json`)
        continue
      }

      if (existingAddress) {
        // Remove old entry
        delete facets[existingAddress]
        consola.info(`ℹ️  Updating ${entry.name} address in tron.diamond.json`)
      }

      // Get version if not provided
      let version = entry.version
      if (!version)
        try {
          version = await getContractVersion(entry.name)
        } catch {
          version = '1.0.0'
          consola.warn(
            `⚠️  Could not determine version for ${entry.name}, using default: ${version}`
          )
        }

      // Add facet entry
      facets[entry.address] = {
        Name: entry.name,
        Version: version,
      }
      updatedCount++
    }

    if (updatedCount > 0) {
      // Write updated file
      await Bun.write(
        diamondJsonPath,
        JSON.stringify(diamondData, null, 2) + '\n'
      )

      consola.success(
        `✅ Updated tron.diamond.json with ${updatedCount} facet(s)`
      )
    }
  } catch (error: any) {
    consola.error('❌ Failed to update tron.diamond.json:', error.message)
    // Don't throw - this is not critical for the deployment
  }
}

/**
 * Update tron.diamond.json with periphery contract information
 * @param contractAddress - The Tron address of the contract (base58 format)
 * @param contractName - The name of the contract (e.g., 'ERC20Proxy')
 */
export async function updateDiamondJsonPeriphery(
  contractAddress: string,
  contractName: string
): Promise<void> {
  try {
    const diamondJsonPath = resolve(
      process.cwd(),
      'deployments',
      'tron.diamond.json'
    )

    // Read existing file or create new structure
    let diamondData: any
    try {
      const fileContent = await Bun.file(diamondJsonPath).text()
      diamondData = JSON.parse(fileContent)
    } catch {
      // File doesn't exist or is invalid, create new structure
      diamondData = {
        LiFiDiamond: {
          Facets: {},
          Periphery: {},
        },
      }
    }

    // Ensure structure exists
    if (!diamondData.LiFiDiamond)
      diamondData.LiFiDiamond = {
        Facets: {},
        Periphery: {},
      }

    if (!diamondData.LiFiDiamond.Periphery)
      diamondData.LiFiDiamond.Periphery = {}

    // Update or add periphery contract (simple key-value format)
    const periphery = diamondData.LiFiDiamond.Periphery

    if (periphery[contractName] === contractAddress) {
      consola.info(
        `ℹ️  ${contractName} already exists in tron.diamond.json with same address`
      )
      return
    }

    if (periphery[contractName])
      consola.info(`ℹ️  Updating ${contractName} address in tron.diamond.json`)

    // Set the contract address (simple format: name -> address)
    periphery[contractName] = contractAddress

    // Write updated file
    await Bun.write(
      diamondJsonPath,
      JSON.stringify(diamondData, null, 2) + '\n'
    )

    consola.success(
      `✅ Updated tron.diamond.json with ${contractName} (Periphery)`
    )
  } catch (error: any) {
    consola.error('❌ Failed to update tron.diamond.json:', error.message)
    // Don't throw - this is not critical for the deployment
  }
}

/**
 * Extract function selectors from Forge artifact
 * @param facetName - Name of the facet contract
 * @param excludeSelectors - Array of selectors to exclude (optional, with or without 0x prefix)
 * @returns Array of function selectors as hex strings with 0x prefix
 */
export async function getFacetSelectors(
  facetName: string,
  excludeSelectors: string[] = []
): Promise<string[]> {
  const artifactPath = resolve(
    process.cwd(),
    'out',
    `${facetName}.sol`,
    `${facetName}.json`
  )

  // Check if artifact exists
  try {
    const exists = await Bun.file(artifactPath).exists()
    if (!exists) 
      throw new Error(
        `Build artifact not found for ${facetName}. Run 'forge build' first.`
      )
    
  } catch (error) {
    throw new Error(
      `Build artifact not found for ${facetName}. Run 'forge build' first.`
    )
  }

  // Read artifact file
  const artifact = await Bun.file(artifactPath).json()

  if (!artifact.methodIdentifiers) 
    throw new Error(`No method identifiers found in ${facetName} artifact`)
  

  // Extract all selectors and add 0x prefix
  let selectors = Object.values(
    artifact.methodIdentifiers as Record<string, string>
  ).map((selector) => '0x' + selector)

  // Filter out excluded selectors if any
  if (excludeSelectors.length > 0) {
    // Normalize exclude list (ensure all have 0x prefix for comparison)
    const excludeSet = new Set(
      excludeSelectors.map((s) =>
        s.startsWith('0x') ? s.toLowerCase() : '0x' + s.toLowerCase()
      )
    )
    selectors = selectors.filter((s) => !excludeSet.has(s.toLowerCase()))
  }

  consola.info(`📋 Extracted ${selectors.length} selectors for ${facetName}:`)
  selectors.forEach((s) => consola.info(`   ${s}`))

  return selectors
}
