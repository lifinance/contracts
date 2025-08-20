import { resolve } from 'path'

import { consola } from 'consola'
import { TronWeb } from 'tronweb'

import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'
import type { SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'

import {
  DIAMOND_CUT_ENERGY_MULTIPLIER,
  ZERO_ADDRESS,
  MIN_BALANCE_REGISTRATION,
  DEFAULT_FEE_LIMIT_TRX,
  MIN_BALANCE_WARNING,
} from './constants'
import type {
  IForgeArtifact,
  IDeploymentResult,
  INetworkInfo,
  IDiamondRegistrationResult,
} from './types'

// Re-export constants for backward compatibility
export { DEFAULT_SAFETY_MARGIN } from './constants'

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
 * Get list of core facets from global config
 */
export function getCoreFacets(): string[] {
  const facets = (globalConfig as any).coreFacets || []
  // Filter out GasZipFacet for TRON deployment
  return facets.filter((facet: string) => facet !== 'GasZipFacet')
}

/**
 * Get list of core periphery contracts for Tron deployment
 * Filters out contracts that are not deployed on Tron
 */
export function getTronCorePeriphery(): string[] {
  const periphery = (globalConfig as any).corePeriphery || []
  // Filter out contracts not deployed on Tron
  return periphery.filter(
    (contract: string) =>
      contract !== 'LiFiTimelockController' && // Tron doesn't use Timelock yet
      contract !== 'GasZipPeriphery' && // Not deployed on Tron
      contract !== 'LiFiDEXAggregator' && // Not deployed on Tron
      contract !== 'Permit2Proxy' // Not deployed on Tron
  )
}

/**
 * Check if a contract is deployed on Tron
 * @param contract The contract name
 * @param deployedContracts The deployed contracts record
 * @param tronWeb The TronWeb instance
 * @returns Promise<boolean> indicating if the contract is deployed
 */
export async function checkIsDeployedTron(
  contract: string,
  deployedContracts: Record<string, string>,
  tronWeb: any
): Promise<boolean> {
  if (!deployedContracts[contract]) return false

  try {
    // For Tron, addresses in deployments are already in Tron format
    const tronAddress = deployedContracts[contract]
    const contractInfo = await tronWeb.trx.getContract(tronAddress)
    return contractInfo && contractInfo.contract_address
  } catch {
    return false
  }
}

/**
 * Execute shell command
 * SECURITY WARNING: This function executes shell commands directly.
 * - Only use with trusted, hardcoded commands
 * - All dynamic input MUST be escaped using escapeShellArg() before concatenation
 * - Never pass user input directly to this function
 * @param command The shell command to execute
 * @returns The command output
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
export async function getEnvironment(): Promise<EnvironmentEnum> {
  const productionValue = await executeShellCommand(
    'source script/config.sh && echo $PRODUCTION'
  )
  return productionValue === 'true'
    ? EnvironmentEnum.production
    : EnvironmentEnum.staging
}

/**
 * Get the correct private key based on environment
 */
export async function getPrivateKey(): Promise<string> {
  const environment = await getEnvironment()
  return getPrivateKeyForEnvironment(environment)
}

/**
 * Log deployment using existing helperFunctions.sh
 */
export async function logDeployment(
  contract: string,
  network: SupportedChain,
  address: string,
  version: string,
  constructorArgs: string,
  verified = false
): Promise<void> {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const environment = await getEnvironment()

  // Escape shell arguments to prevent injection
  const escapeShellArg = (arg: string) => `'${arg.replace(/'/g, "'\"'\"'")}'`

  const environmentString =
    environment === EnvironmentEnum.production ? 'production' : 'staging'
  const logCommand = [
    'script/helperFunctions.sh',
    'logDeployment',
    escapeShellArg(contract),
    escapeShellArg(network),
    escapeShellArg(timestamp),
    escapeShellArg(version),
    '"200"',
    escapeShellArg(constructorArgs),
    escapeShellArg(environmentString),
    escapeShellArg(address),
    escapeShellArg(String(verified)),
    escapeShellArg(''),
    escapeShellArg('0.8.17'),
    escapeShellArg('cancun'), // Using EVM version from foundry.toml, though Tron actually uses TVM
    escapeShellArg(''),
  ].join(' ')

  await executeShellCommand(logCommand)
}

/**
 * Save contract address to deployments file
 */
export async function saveContractAddress(
  network: SupportedChain,
  contract: string,
  address: string
): Promise<void> {
  const environment = await getEnvironment()
  const fileSuffix =
    environment === EnvironmentEnum.production ? '' : 'staging.'
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
  network: SupportedChain,
  contract: string
): Promise<string | null> {
  const environment = await getEnvironment()
  const fileSuffix =
    environment === EnvironmentEnum.production ? '' : 'staging.'
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
  network: SupportedChain,
  _diamondAddress: string,
  facets: Record<string, { address: string; version: string }>
): Promise<void> {
  const environment = await getEnvironment()
  const fileSuffix =
    environment === EnvironmentEnum.production ? '' : 'staging.'
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
  version?: string,
  network: SupportedChain = 'tron'
): Promise<void> {
  try {
    const diamondJsonPath = resolve(
      process.cwd(),
      'deployments',
      `${network}.diamond.json`
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
          consola.info(`${facetName} already exists in ${network}.diamond.json`)
          return
        } else {
          // Same facet name but different address - update it
          consola.info(
            `Updating ${facetName} address in ${network}.diamond.json`
          )
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
          `Could not determine version for ${facetName}, using default: ${version}`
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

    consola.success(`Updated ${network}.diamond.json with ${facetName}`)
  } catch (error: any) {
    consola.error(`Failed to update ${network}.diamond.json:`, error.message)
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
  }>,
  network: SupportedChain = 'tron'
): Promise<void> {
  try {
    const diamondJsonPath = resolve(
      process.cwd(),
      'deployments',
      `${network}.diamond.json`
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
        consola.info(`${entry.name} already exists in tron.diamond.json`)
        continue
      }

      if (existingAddress) {
        // Remove old entry
        delete facets[existingAddress]
        consola.info(
          `Updating ${entry.name} address in ${network}.diamond.json`
        )
      }

      // Get version if not provided
      let version = entry.version
      if (!version)
        try {
          version = await getContractVersion(entry.name)
        } catch {
          version = '1.0.0'
          consola.warn(
            `Could not determine version for ${entry.name}, using default: ${version}`
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
        `Updated ${network}.diamond.json with ${updatedCount} facet(s)`
      )
    }
  } catch (error: any) {
    consola.error(`Failed to update ${network}.diamond.json:`, error.message)
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
  contractName: string,
  network: SupportedChain = 'tron'
): Promise<void> {
  try {
    const diamondJsonPath = resolve(
      process.cwd(),
      'deployments',
      `${network}.diamond.json`
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
        `${contractName} already exists in ${network}.diamond.json with same address`
      )
      return
    }

    if (periphery[contractName])
      consola.info(
        `Updating ${contractName} address in ${network}.diamond.json`
      )

    // Set the contract address (simple format: name -> address)
    periphery[contractName] = contractAddress

    // Write updated file
    await Bun.write(
      diamondJsonPath,
      JSON.stringify(diamondData, null, 2) + '\n'
    )

    consola.success(
      `Updated ${network}.diamond.json with ${contractName} (Periphery)`
    )
  } catch (error: any) {
    consola.error(`Failed to update ${network}.diamond.json:`, error.message)
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

  consola.info(`Extracted ${selectors.length} selectors for ${facetName}:`)
  selectors.forEach((s) => consola.info(`   ${s}`))

  return selectors
}

/**
 * Check if a contract is already deployed and prompt for redeploy
 */
export async function checkExistingDeployment(
  network: SupportedChain,
  contractName: string,
  dryRun = false
): Promise<{
  exists: boolean
  address: string | null
  shouldRedeploy: boolean
}> {
  const existingAddress = await getContractAddress(network, contractName)

  if (existingAddress && !dryRun) {
    consola.warn(`${contractName} is already deployed at: ${existingAddress}`)
    const shouldRedeploy = await consola.prompt(`Redeploy ${contractName}?`, {
      type: 'confirm',
      initial: false,
    })

    return {
      exists: true,
      address: existingAddress,
      shouldRedeploy,
    }
  }

  return {
    exists: false,
    address: null,
    shouldRedeploy: true,
  }
}
/**
 * Deploy a contract with standard error handling and logging
 */
export async function deployContractWithLogging(
  deployer: any, // TronContractDeployer
  contractName: string,
  constructorArgs: any[] = [],
  dryRun = false,
  network: SupportedChain = 'tron'
): Promise<IDeploymentResult> {
  try {
    const artifact = await loadForgeArtifact(contractName)
    const version = await getContractVersion(contractName)

    consola.info(`Deploying ${contractName} v${version}...`)

    if (constructorArgs.length > 0)
      consola.info(`Constructor arguments:`, constructorArgs)

    const result = await deployer.deployContract(artifact, constructorArgs)

    consola.success(`${contractName} deployed to: ${result.contractAddress}`)
    consola.info(`Transaction: ${result.transactionId}`)
    consola.info(`Cost: ${result.actualCost.trxCost} TRX`)

    // Log deployment (skip in dry run)
    if (!dryRun) {
      // Encode constructor args
      const constructorArgsHex =
        constructorArgs.length > 0
          ? encodeConstructorArgs(constructorArgs)
          : '0x'

      await logDeployment(
        contractName,
        network,
        result.contractAddress,
        version,
        constructorArgsHex,
        false
      )

      await saveContractAddress(network, contractName, result.contractAddress)
    }

    return {
      contract: contractName,
      address: result.contractAddress,
      txId: result.transactionId,
      cost: result.actualCost.trxCost,
      version,
      status: 'success',
    }
  } catch (error: any) {
    consola.error(`Failed to deploy ${contractName}:`, error.message)
    throw error
  }
}

/**
 * Encode constructor arguments to hex
 */
export function encodeConstructorArgs(args: any[]): string {
  // Return empty hex for no arguments
  if (args.length === 0) return '0x'

  try {
    const tronWeb = new TronWeb({
      fullHost: 'https://api.trongrid.io', // [pre-commit-checker: not a secret]
    })

    // Determine types based on argument values
    const types: string[] = args.map((arg) => {
      if (typeof arg === 'string') {
        // Check if it's an address (starts with T or 0x)
        if (arg.startsWith('T') || arg.startsWith('0x')) return 'address'

        return 'string'
      } else if (typeof arg === 'number' || typeof arg === 'bigint')
        return 'uint256'
      else if (typeof arg === 'boolean') return 'bool'
      else if (Array.isArray(arg)) {
        // For arrays, try to determine the element type
        if (arg.length > 0 && typeof arg[0] === 'string') return 'string[]'

        return 'uint256[]'
      }
      return 'bytes'
    })

    // Use TronWeb's ABI encoder
    return tronWeb.utils.abi.encodeParams(types, args)
  } catch (error) {
    consola.warn('Failed to encode constructor args, using fallback:', error)
    // Fallback to simple hex encoding
    return (
      '0x' +
      args
        .map((arg) => {
          if (typeof arg === 'string' && arg.startsWith('0x'))
            return arg.slice(2)

          return Buffer.from(String(arg)).toString('hex')
        })
        .join('')
    )
  }
}

/**
 * Estimate energy for diamondCut transaction
 */
export async function estimateDiamondCutEnergy(
  tronWeb: any,
  diamondAddress: string,
  facetCuts: any[],
  fullHost: string
): Promise<number> {
  try {
    consola.info('Estimating energy for diamondCut...')

    const encodedParams = tronWeb.utils.abi.encodeParams(
      ['(address,uint8,bytes4[])[]', 'address', 'bytes'],
      [facetCuts, ZERO_ADDRESS, '0x']
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

    if (result.result?.result === false)
      throw new Error(
        `Energy estimation failed: ${
          result.result?.message || JSON.stringify(result)
        }`
      )

    if (result.energy_used) {
      const estimatedEnergy = Math.ceil(
        result.energy_used * DIAMOND_CUT_ENERGY_MULTIPLIER
      )
      consola.info(
        `Energy estimate: ${result.energy_used} (with ${DIAMOND_CUT_ENERGY_MULTIPLIER}x safety: ${estimatedEnergy})`
      )
      return estimatedEnergy
    }

    throw new Error('No energy estimation returned')
  } catch (error: any) {
    consola.error('Failed to estimate energy:', error.message)
    throw error
  }
}

/**
 * Register a facet to the diamond
 */
export async function registerFacetToDiamond(
  facetName: string,
  facetAddress: string,
  tronWeb: any,
  fullHost: string,
  dryRun = false,
  networkOrDiamondAddress: SupportedChain | string = 'tron'
): Promise<IDiamondRegistrationResult> {
  try {
    // Determine if we received a network name or a diamond address
    let diamondAddress: string
    let network: SupportedChain

    // Check if it's a Tron address (starts with T) or hex address
    if (
      networkOrDiamondAddress.startsWith('T') ||
      networkOrDiamondAddress.startsWith('0x')
    ) {
      diamondAddress = networkOrDiamondAddress
      // Default to 'tron' for network when diamond address is provided directly
      network = 'tron'
    } else {
      // It's a network name
      network = networkOrDiamondAddress as SupportedChain
      const loadedAddress = await getContractAddress(network, 'LiFiDiamond')
      if (!loadedAddress)
        throw new Error(`LiFiDiamond not found in deployments for ${network}`)
      diamondAddress = loadedAddress
    }

    consola.info(`Registering ${facetName} to LiFiDiamond: ${diamondAddress}`)

    // Load ABIs
    const diamondCutABI = await loadForgeArtifact('DiamondCutFacet')
    const diamondLoupeABI = await loadForgeArtifact('DiamondLoupeFacet')
    const combinedABI = [...diamondCutABI.abi, ...diamondLoupeABI.abi]
    const diamond = tronWeb.contract(combinedABI, diamondAddress)

    // Get function selectors
    const selectors = await getFacetSelectors(facetName)
    consola.info(`Found ${selectors.length} function selectors`)

    // Check if already registered
    const isRegistered = await checkFacetRegistration(
      diamond,
      facetAddress,
      tronWeb
    )
    if (isRegistered) {
      consola.success(`${facetName} is already registered!`)
      return { success: true }
    }

    // Prepare facetCut
    const facetAddressHex = tronWeb.address
      .toHex(facetAddress)
      .replace(/^41/, '0x')
    const facetCuts = [[facetAddressHex, 0, selectors]]

    // Estimate energy
    const estimatedEnergy = await estimateDiamondCutEnergy(
      tronWeb,
      diamondAddress,
      facetCuts,
      fullHost
    )
    // Get current energy price from the network
    const { energyPrice } = await getCurrentPrices(tronWeb)
    const estimatedCost = estimatedEnergy * energyPrice
    consola.info(`Estimated registration cost: ${estimatedCost.toFixed(4)} TRX`)

    if (dryRun) {
      consola.info('Dry run mode - not executing registration')
      return { success: true }
    }

    // Check balance
    const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58)
    const balanceTRX = balance / 1000000
    if (balanceTRX < MIN_BALANCE_REGISTRATION)
      throw new Error(
        `Insufficient balance. Have: ${balanceTRX} TRX, Need: at least ${MIN_BALANCE_REGISTRATION} TRX`
      )

    // Execute diamondCut
    consola.info(`Executing diamondCut...`)
    const feeLimitInSun = DEFAULT_FEE_LIMIT_TRX * 1000000 // Convert to SUN

    const tx = await diamond.diamondCut(facetCuts, ZERO_ADDRESS, '0x').send({
      feeLimit: feeLimitInSun,
      shouldPollResponse: true,
    })

    consola.success(`Registration transaction successful: ${tx}`)

    // Verify registration
    const verified = await verifyFacetRegistration(
      diamond,
      facetAddress,
      facetName,
      tronWeb
    )
    if (!verified)
      throw new Error(
        `${facetName} not found in registered facets after registration`
      )

    // Update diamond.json
    await updateDiamondJson(facetAddress, facetName, undefined, network)

    return { success: true, transactionId: tx }
  } catch (error: any) {
    consola.error(`Registration failed:`, error.message)
    return { success: false, error: error.message }
  }
}

/**
 * Check if a facet is already registered
 */
export async function checkFacetRegistration(
  diamond: any,
  facetAddress: string,
  tronWeb: any
): Promise<boolean> {
  try {
    const facetsResponse = await diamond.facets().call()
    const currentFacets = Array.isArray(facetsResponse[0])
      ? facetsResponse[0]
      : facetsResponse

    for (const facet of currentFacets) {
      const registeredAddress = tronWeb.address.fromHex(facet[0])
      if (registeredAddress === facetAddress) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Verify facet registration after diamondCut
 */
export async function verifyFacetRegistration(
  diamond: any,
  facetAddress: string,
  facetName: string,
  tronWeb: any
): Promise<boolean> {
  consola.info('Verifying registration...')

  const facetsResponse = await diamond.facets().call()
  const facets = Array.isArray(facetsResponse[0])
    ? facetsResponse[0]
    : facetsResponse

  for (const facet of facets) {
    const facetBase58 = tronWeb.address.fromHex(facet[0])
    if (facetBase58 === facetAddress) {
      consola.success(
        `${facetName} registered successfully with ${facet[1].length} functions`
      )
      return true
    }
  }

  return false
}

/**
 * Convert hex address to Tron base58 format
 */
export function hexToTronAddress(hexAddress: string, tronWeb: any): string {
  if (hexAddress === ZERO_ADDRESS)
    return tronWeb.address.fromHex('410000000000000000000000000000000000000000')

  return tronWeb.address.fromHex(hexAddress.replace('0x', '41'))
}

/**
 * Convert Tron base58 address to hex format
 */
export function tronAddressToHex(tronAddress: string, tronWeb: any): string {
  return '0x' + tronWeb.address.toHex(tronAddress).substring(2)
}

/**
 * Validate network balance before deployment
 */
export async function validateBalance(
  tronWeb: any,
  requiredTrx: number,
  operation = 'deployment'
): Promise<void> {
  const balance = await tronWeb.trx.getBalance(tronWeb.defaultAddress.base58)
  const balanceTrx = tronWeb.fromSun(balance)

  if (balanceTrx < requiredTrx)
    throw new Error(
      `Insufficient balance for ${operation}: ${balanceTrx} TRX available, ${requiredTrx} TRX required`
    )

  if (balanceTrx < MIN_BALANCE_WARNING)
    consola.warn(`Low balance detected: ${balanceTrx} TRX`)
}

/**
 * Display deployment confirmation prompt
 */
export async function confirmDeployment(
  environment: EnvironmentEnum,
  network: SupportedChain,
  contracts: string[]
): Promise<boolean> {
  const isProduction = environment === EnvironmentEnum.production
  const networkName = network.includes('shasta') ? 'Shasta Testnet' : 'Mainnet'

  // Use consola.box for deployment plan
  const planContent = contracts
    .map((contract, index) => `${index + 1}. ${contract}`)
    .join('\n')

  consola.box({
    title: 'Deployment Plan',
    message: planContent,
    style: {
      borderColor: 'yellow',
    },
  })

  if (isProduction)
    consola.warn(
      `WARNING: This will deploy to Tron ${networkName} in PRODUCTION!`
    )
  else consola.warn(`This will deploy to Tron ${networkName} in STAGING!`)

  const shouldContinue = await consola.prompt('Do you want to continue?', {
    type: 'confirm',
    initial: !isProduction,
  })

  if (!shouldContinue) {
    consola.info('Deployment cancelled')
    return false
  }

  return true
}

/**
 * Print deployment summary
 */
export function printDeploymentSummary(
  results: IDeploymentResult[],
  dryRun = false
): void {
  // Group by status
  const successful = results.filter((r) => r.status !== 'failed')
  const failed = results.filter((r) => r.status === 'failed')

  let summaryContent = ''

  if (successful.length > 0) {
    summaryContent += 'Successful deployments:\n'
    successful.forEach((r) => {
      summaryContent += `  ${r.contract}: ${r.address}\n`
      if (r.cost > 0) summaryContent += `    Cost: ${r.cost.toFixed(4)} TRX\n`
    })
  }

  if (failed.length > 0) {
    summaryContent += `\nFailed deployments (${failed.length}):\n`
    failed.forEach((r) => {
      summaryContent += `  - ${r.contract}\n`
    })
    summaryContent +=
      '\nPlease review the errors above and retry failed deployments.'
  }

  if (dryRun)
    summaryContent +=
      '\n\nThis was a DRY RUN - no contracts were actually deployed'

  consola.box({
    title: 'Deployment Summary',
    message: summaryContent,
    style: {
      borderColor: failed.length > 0 ? 'red' : 'green',
    },
  })
}

/**
 * Display network info in a formatted box
 */
export function displayNetworkInfo(
  networkInfo: INetworkInfo,
  environment: EnvironmentEnum,
  rpcUrl: string
): void {
  const networkName = rpcUrl.includes('shasta') ? 'Shasta Testnet' : 'Mainnet'
  const environmentString =
    environment === EnvironmentEnum.production ? 'PRODUCTION' : 'STAGING'

  const infoContent = `
Network: ${networkName}
RPC URL: ${rpcUrl}
Environment: ${environmentString}
Address: ${networkInfo.address}
Balance: ${networkInfo.balance} TRX
Block: ${networkInfo.block}
`.trim()

  consola.box({
    title: 'Network Information',
    message: infoContent,
    style: {
      borderColor: 'blue',
    },
  })
}

/**
 * Display registration info in a formatted box
 */
export function displayRegistrationInfo(
  facetName: string,
  facetAddress: string,
  diamondAddress: string,
  selectors: string[]
): void {
  const infoContent = `
Facet: ${facetName}
Address: ${facetAddress}
Diamond: ${diamondAddress}
Selectors: ${selectors.length} functions
`.trim()

  consola.box({
    title: 'Registration Information',
    message: infoContent,
    style: {
      borderColor: 'cyan',
    },
  })
}
// Cache for prices with TTL
interface IPriceCache {
  energyPrice: number
  bandwidthPrice: number
  timestamp: number
}

let priceCache: IPriceCache | null = null
const CACHE_TTL = 60 * 60 * 1000 // 1 hour in milliseconds

// Fallback values (in TRX) - only used if API fails
const FALLBACK_ENERGY_PRICE = 0.00021 // TRX per energy unit
const FALLBACK_BANDWIDTH_PRICE = 0.001 // TRX per bandwidth point

/**
 * Parse the latest applicable price from Tron's price history string
 * Format: "timestamp1:price1,timestamp2:price2,..."
 * Returns the price in SUN for the most recent timestamp that's not in the future
 */
function parseLatestPrice(priceString: string): number {
  const now = Date.now()
  const prices = priceString.split(',').map((entry) => {
    const parts = entry.split(':')
    const timestamp = Number(parts[0] || 0)
    const price = Number(parts[1] || 0)
    return { timestamp, price }
  })

  // Sort by timestamp descending
  prices.sort((a, b) => b.timestamp - a.timestamp)

  // Find the most recent price that's not in the future
  for (const { timestamp, price } of prices) if (timestamp <= now) return price

  // If all timestamps are in the future (shouldn't happen), use the oldest one
  const lastPrice = prices[prices.length - 1]
  return lastPrice ? lastPrice.price : 0
}

/**
 * Get current energy and bandwidth prices from the Tron network
 * Prices are returned in TRX (not SUN)
 * Results are cached for 1 hour to reduce API calls
 */
export async function getCurrentPrices(
  tronWeb: TronWeb
): Promise<{ energyPrice: number; bandwidthPrice: number }> {
  // Check cache first
  if (priceCache && Date.now() - priceCache.timestamp < CACHE_TTL) {
    consola.debug('Using cached prices')
    return {
      energyPrice: priceCache.energyPrice,
      bandwidthPrice: priceCache.bandwidthPrice,
    }
  }

  try {
    consola.debug('Fetching current prices from Tron network...')

    const [energyPricesStr, bandwidthPricesStr] = await Promise.all([
      tronWeb.trx.getEnergyPrices(),
      tronWeb.trx.getBandwidthPrices(),
    ])

    // Parse the price strings to get the latest applicable prices
    const energyPriceSun = parseLatestPrice(energyPricesStr)
    const bandwidthPriceSun = parseLatestPrice(bandwidthPricesStr)

    // Convert from SUN to TRX (1 TRX = 1,000,000 SUN)
    const energyPrice = energyPriceSun / 1_000_000
    const bandwidthPrice = bandwidthPriceSun / 1_000_000

    // Update cache
    priceCache = {
      energyPrice,
      bandwidthPrice,
      timestamp: Date.now(),
    }

    consola.debug(
      `Current prices - Energy: ${energyPrice} TRX, Bandwidth: ${bandwidthPrice} TRX`
    )

    return { energyPrice, bandwidthPrice }
  } catch (error) {
    consola.warn(
      'Failed to fetch current prices from network, using fallback values:',
      error
    )

    // Use fallback values if API fails
    return {
      energyPrice: FALLBACK_ENERGY_PRICE,
      bandwidthPrice: FALLBACK_BANDWIDTH_PRICE,
    }
  }
}

/**
 * Clear the price cache (useful for testing or forcing a refresh)
 */
export function clearPriceCache(): void {
  priceCache = null
}

/**
 * Calculate the estimated cost in TRX based on energy and bandwidth usage
 */
export async function calculateEstimatedCost(
  tronWeb: TronWeb,
  estimatedEnergy: number,
  estimatedBandwidth = 0
): Promise<{ energyCost: number; bandwidthCost: number; totalCost: number }> {
  const { energyPrice, bandwidthPrice } = await getCurrentPrices(tronWeb)

  const energyCost = estimatedEnergy * energyPrice
  const bandwidthCost = estimatedBandwidth * bandwidthPrice
  const totalCost = energyCost + bandwidthCost

  return {
    energyCost,
    bandwidthCost,
    totalCost,
  }
}
