import { resolve } from 'path'

import { consola } from 'consola'

import type { SupportedChain } from '../../common/types'
import { EnvironmentEnum } from '../../common/types'
import { getPrivateKeyForEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import { sleep } from '../../utils/delay'
import { fetchWithTimeout } from '../../utils/fetchWithTimeout'
import { spawnAndCapture } from '../../utils/spawnAndCapture'
import {
  INITIAL_CALL_DELAY,
  MAX_RETRIES,
  RETRY_DELAY,
  ZERO_ADDRESS,
} from '../shared/constants'
import { isRateLimitError } from '../shared/rateLimit'

import {
  DEFAULT_FEE_LIMIT_TRX,
  DIAMOND_CUT_ENERGY_MULTIPLIER,
  MIN_BALANCE_REGISTRATION,
  MIN_BALANCE_WARNING,
  TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
  TRON_WALLET_API_FETCH_TIMEOUT_MS,
  TRON_ZERO_ADDRESS,
} from './constants'
import { getContractVersion } from './helpers/getContractVersion'
import { loadForgeArtifact } from './helpers/loadForgeArtifact'
import { getCurrentPrices } from './helpers/tronPricing'
import { buildTronWalletJsonPostHeaders } from './helpers/tronRpcConfig'
import {
  getTronWebCodecFullHost,
  getTronWebCodecOnly,
} from './helpers/tronWebCodecOnly'
import { createTronWebReadOnly } from './helpers/tronWebFactory'
import {
  tronAddressToHex,
  tryTronFacetLoupeAddressToBase58,
} from './tronAddressHelpers'
import type {
  IDeploymentResult,
  IDiamondRegistrationResult,
  INetworkInfo,
} from './types'

/**
 * Prompt user to confirm they are aware they can rent energy (e.g. Zinergy.ag, 1 hr) to reduce TRON deployment costs.
 * Call before starting deployments when not in dry run. If user declines, exits the process.
 */
export async function promptEnergyRentalReminder(): Promise<void> {
  consola.info(
    'Tip: You can rent energy (e.g. from Zinergy.ag for 1 hour) to reduce TRX burn during deployment.'
  )
  const proceed = await consola.prompt('Continue with deployment?', {
    type: 'confirm',
    initial: true,
  })
  if (proceed !== true) {
    consola.info('Deployment cancelled.')
    process.exit(0)
  }
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
  if (!deployedContracts[contract]) {
    consola.warn(
      `Contract "${contract}" not found in deployments file. Ensure deployments/tron.json (or .staging) contains this contract.`
    )
    return false
  }

  // For Tron, addresses in deployments are already in Tron format
  const tronAddress = deployedContracts[contract]

  // Add initial delay for Tron to avoid rate limits
  await sleep(INITIAL_CALL_DELAY)

  type GetContractResult = { contract_address?: string } | null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY)
    try {
      const contractInfo = (await tronWeb.trx.getContract(
        tronAddress
      )) as GetContractResult
      const address = contractInfo?.contract_address
      if (address) return true
      consola.warn(
        `Contract "${contract}" at ${tronAddress}: getContract returned no contract_address (contract may not exist on-chain).`
      )
      return false
    } catch (error: unknown) {
      const shouldRetry = isRateLimitError(error) && attempt < MAX_RETRIES
      if (!shouldRetry) {
        const msg = error instanceof Error ? error.message : String(error)
        consola.warn(
          `Contract "${contract}" at ${tronAddress}: getContract failed after retries. Reason: ${msg}`
        )
        return false
      }
    }
  }

  consola.warn(
    `Contract "${contract}" at ${tronAddress}: getContract failed after retries.`
  )
  return false
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
  return spawnAndCapture('bash', ['-c', command])
}

/**
 * Get deployment environment from config.sh
 */
export async function getEnvironment(): Promise<EnvironmentEnum> {
  const productionValue = (
    await executeShellCommand('source script/config.sh && echo $PRODUCTION')
  ).trim()
  return productionValue === 'true'
    ? EnvironmentEnum.production
    : EnvironmentEnum.staging
}

/**
 * Candidate repository roots for `deployments/*.json`.
 * Scripts may run from the `contracts` package directory or a parent workspace path.
 */
export function getDeploymentRoots(): string[] {
  const cwd = resolve(process.cwd())
  const candidates = [cwd, resolve(cwd, 'contracts'), resolve(cwd, '..')]
  const seen = new Set<string>()
  const roots: string[] = []
  for (const candidate of candidates) {
    const norm = resolve(candidate)
    if (!seen.has(norm)) {
      seen.add(norm)
      roots.push(norm)
    }
  }
  return roots
}

/**
 * Pick where to write `deployments/*.json` so parent-workspace cwd matches reads in
 * {@link getContractAddress} (existing file or `deployments/`), not only candidate order.
 */
async function pickDeploymentRootForWrites(
  network: SupportedChain,
  fileSuffix: string
): Promise<string> {
  const roots = getDeploymentRoots()
  const envDeploymentPath = `deployments/${network}.${fileSuffix}json`

  for (const candidate of roots)
    if (await Bun.file(resolve(candidate, envDeploymentPath)).exists())
      return candidate

  for (const candidate of roots)
    if (await Bun.file(resolve(candidate, 'deployments')).exists())
      return candidate

  const fallback = roots[0]
  if (!fallback) throw new Error('No deployment root available')
  return fallback
}

/**
 * Read and parse a JSON file. Returns null if the file is missing or not valid JSON.
 */
export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return (await Bun.file(filePath).json()) as T
  } catch {
    return null
  }
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
  const root = await pickDeploymentRootForWrites(network, fileSuffix)
  const deploymentFile = resolve(
    root,
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
 * Get contract address from deployments file.
 * Tries env-specific file first, then base network file; for Tron also tries alternate roots (e.g. cwd vs cwd/contracts).
 */
export async function getContractAddress(
  network: SupportedChain,
  contract: string
): Promise<string | null> {
  const environment = await getEnvironment()
  const fileSuffix =
    environment === EnvironmentEnum.production ? '' : 'staging.'
  const roots = getDeploymentRoots()

  const filesToTry: string[] = []
  for (const root of roots) {
    filesToTry.push(resolve(root, `deployments/${network}.${fileSuffix}json`))
    filesToTry.push(resolve(root, `deployments/${network}.json`))
  }
  // When staging Tron, mainnet deployment may be the only file
  if (network === 'tronshasta')
    for (const root of roots)
      filesToTry.push(resolve(root, 'deployments/tron.json'))

  for (const deploymentFile of filesToTry) {
    const deployments = await readJsonFile<Record<string, string>>(
      deploymentFile
    )
    if (deployments) {
      const address = deployments[contract] || null
      if (address) return address
    }
  }

  return null
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

  if (existingAddress) {
    // Always prompt user whether to redeploy (same behavior in both dryRun and non-dryRun)
    consola.warn(`${contractName} is already deployed at: ${existingAddress}`)
    const dryRunSuffix = dryRun ? ' (DRY RUN - will simulate)' : ''
    const shouldRedeploy = await consola.prompt(
      `Redeploy ${contractName}?${dryRunSuffix}`,
      {
        type: 'confirm',
        initial: false,
      }
    )

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
 * Wait between deployments using TronGrid RPC calls
 * Uses lightweight RPC calls (getNowBlock) to wait, which naturally respects rate limits
 * @param seconds Number of seconds to wait
 * @param verbose Whether to log the wait message
 * @param tronWeb Optional TronWeb instance (if not provided, will create a minimal one)
 * @param fullHost Optional Tron RPC URL (if not provided, will use default)
 * @param headers Optional headers for API key authentication
 */
export async function waitBetweenDeployments(
  seconds: number,
  verbose = false,
  tronWeb?: any,
  fullHost?: string,
  headers?: Record<string, string>
): Promise<void> {
  if (seconds <= 0) return

  if (verbose) {
    consola.debug(
      `Waiting ${seconds} second(s) using TronGrid RPC calls to avoid rate limits...`
    )
  }

  // Calculate number of RPC calls to make (one per second)
  const numCalls = Math.ceil(seconds)
  const delayPerCall = Math.max(1000, Math.floor((seconds * 1000) / numCalls))

  // Use provided TronWeb or create a minimal one for RPC calls
  let rpcTronWeb = tronWeb
  if (!rpcTronWeb && fullHost) {
    rpcTronWeb = createTronWebReadOnly({
      rpcUrl: fullHost,
      headers,
    })
  } else if (!rpcTronWeb) {
    rpcTronWeb = createTronWebReadOnly({
      rpcUrl: getTronWebCodecFullHost(),
      verbose,
    })
  }

  // Make lightweight RPC calls to wait (getNowBlock is a lightweight call)
  for (let i = 0; i < numCalls; i++) {
    try {
      // Use getNowBlock as a lightweight RPC call to wait
      // This naturally respects rate limits and provides actual network interaction
      await rpcTronWeb.trx.getNowBlock()

      if (i < numCalls - 1) {
        // Wait between calls (except for the last one)
        await sleep(delayPerCall)
      }
    } catch (error) {
      // If RPC call fails, fall back to simple timeout
      if (verbose) {
        consola.debug(
          `RPC call failed during wait, using timeout fallback: ${error}`
        )
      }
      await sleep(delayPerCall)
    }
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
          ? await encodeConstructorArgs(constructorArgs)
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
export async function encodeConstructorArgs(args: any[]): Promise<string> {
  // Return empty hex for no arguments
  if (args.length === 0) return '0x'

  try {
    const tronWeb = getTronWebCodecOnly()

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
      fee_limit: TRON_TRIGGER_ESTIMATE_FEE_LIMIT_SUN,
      call_value: 0,
      visible: true,
    }

    let response: Response
    try {
      response = await fetchWithTimeout(
        apiUrl,
        {
          method: 'POST',
          headers: buildTronWalletJsonPostHeaders(fullHost),
          body: JSON.stringify(payload),
        },
        TRON_WALLET_API_FETCH_TIMEOUT_MS
      )
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError')
        throw new Error(
          `triggerconstantcontract timed out after ${TRON_WALLET_API_FETCH_TIMEOUT_MS}ms`
        )
      throw e
    }

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

    const facetAddressHex = tronAddressToHex(tronWeb, facetAddress)

    // Check each selector and group by action needed
    const selectorsToAdd = []
    const selectorsToReplace = []
    let alreadyRegisteredCount = 0

    for (const selector of selectors)
      try {
        const currentFacetAddressRaw = await diamond
          .facetAddress(selector)
          .call()
        const currentFacetAddress = String(currentFacetAddressRaw)

        const isZeroAddress =
          !currentFacetAddress ||
          currentFacetAddress === 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' ||
          currentFacetAddress ===
            '0x0000000000000000000000000000000000000000' ||
          currentFacetAddress === TRON_ZERO_ADDRESS ||
          currentFacetAddress === ZERO_ADDRESS

        if (isZeroAddress) selectorsToAdd.push(selector)
        else {
          const currentHex = tronWeb.address
            .toHex(currentFacetAddress)
            .toLowerCase()
          const targetHex = tronWeb.address.toHex(facetAddress).toLowerCase()

          if (currentHex === targetHex) alreadyRegisteredCount++
          else {
            selectorsToReplace.push(selector)
            consola.debug(
              `Selector ${selector} currently on ${currentFacetAddress}, will replace with ${facetAddress}`
            )
          }
        }
      } catch (error) {
        consola.debug(
          `Could not check selector ${selector}, assuming ADD needed`
        )
        selectorsToAdd.push(selector)
      }

    // Build facetCuts array based on what's needed
    const facetCuts = []

    if (selectorsToAdd.length > 0) {
      facetCuts.push([facetAddressHex, 0, selectorsToAdd]) // 0 = Add
      consola.info(`Will ADD ${selectorsToAdd.length} new selectors`)
    }

    if (selectorsToReplace.length > 0) {
      facetCuts.push([facetAddressHex, 1, selectorsToReplace]) // 1 = Replace
      consola.info(
        `Will REPLACE ${selectorsToReplace.length} existing selectors`
      )
    }

    if (alreadyRegisteredCount > 0)
      consola.info(
        `${alreadyRegisteredCount} selectors already registered to this facet`
      )

    // If nothing to do, exit early
    if (facetCuts.length === 0) {
      consola.success(`${facetName} is already fully registered!`)
      return { success: true }
    }

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
    const facetBase58 = tryTronFacetLoupeAddressToBase58(tronWeb, facet[0])
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

export { estimateContractCallEnergy } from './helpers/estimateContractEnergy'
export { loadForgeArtifact } from './helpers/loadForgeArtifact'
export { getCoreFacets, getTronCorePeriphery } from './helpers/tronGlobalFacets'
export {
  getNetworkConfig,
  getTronGridAPIKey,
  getTronRPCConfig,
} from './helpers/tronRpcConfig'
export { getContractVersion } from './helpers/getContractVersion'
export {
  calculateEstimatedCost,
  calculateTransactionBandwidth,
  getAccountAvailableResources,
  getCurrentPrices,
} from './helpers/tronPricing'
export { parseTroncastFacetsOutput } from './helpers/parseTroncastFacetsOutput'
export { applyTronGridViemTransportExtras } from './helpers/tronGridTransport'
export { isTronGridRpcUrl } from './helpers/isTronGridRpcUrl'
export { formatAddressForNetworkCliDisplay } from './helpers/formatAddressForCliDisplay'
export {
  getTronWebCodecFullHost,
  getTronWebCodecOnly,
} from './helpers/tronWebCodecOnly'
