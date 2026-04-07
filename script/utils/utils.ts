/**
 * Low-level network config, RPC URL helpers, and generic deployment utilities
 * shared by deploy scripts and tasks.
 */

import 'dotenv/config'

import { readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { consola } from 'consola'
import type { Hex } from 'viem'

import networksConfig from '../../config/networks.json'
import type {
  EVMVersion,
  IDeploymentResult,
  IFoundryProfileDefaultConfig,
  IFoundryTomlConfig,
  INetwork,
  INetworkInfo,
  INetworksObject,
  SupportedChain,
} from '../common/types'
import { EnvironmentEnum } from '../common/types'
import { EVM_VERSIONS } from '../deploy/shared/constants'
import { getContractVersion } from '../deploy/shared/getContractVersion'

import { spawnAndCapture } from './spawnAndCapture'

const networks: INetworksObject = networksConfig

/**
 * Returns the environment variable name for a network’s RPC URL.
 * Must match `helperFunctions.sh` `getRPCEnvVarName`.
 */
export function getRPCEnvVarName(networkName: string): string {
  return `ETH_NODE_URI_${networkName.toUpperCase().replace(/-/g, '_')}`
}

/**
 * Resolves the RPC URL for a network from environment variables.
 * Priority: `ETH_NODE_URI_<NETWORK>` → `ETH_NODE_URI` (with `{{networkName}}` substitution).
 * Returns `'http://localhost:8545'` for `'localhost'`, and `''` if no URL is configured. [pre-commit-checker: not a secret]
 */
export function node_url(networkName: string): string {
  if (networkName) {
    const uri = process.env['ETH_NODE_URI_' + networkName.toUpperCase()]
    if (uri && uri !== '') return uri
  }

  if (networkName === 'localhost')
    // do not use ETH_NODE_URI
    return 'http://localhost:8545' // [pre-commit-checker: not a secret]

  let uri = process.env.ETH_NODE_URI
  if (uri) uri = uri.replace('{{networkName}}', networkName)

  if (!uri || uri === '')
    // throw new Error(`environment variable "ETH_NODE_URI" not configured `);
    return ''

  if (uri.indexOf('{{') >= 0)
    throw new Error(
      `invalid uri or network not supported by node provider : ${uri}`
    )

  return uri
}

const FOUNDRY_TOML_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../foundry.toml'
)

function readFoundryProfileDefaultConfig(): IFoundryProfileDefaultConfig {
  const content = readFileSync(FOUNDRY_TOML_PATH, 'utf8')

  try {
    const parsed = Bun.TOML.parse(content) as IFoundryTomlConfig
    const defaultProfile = parsed.profile?.default
    if (!defaultProfile)
      throw new Error('Missing [profile.default] section in foundry.toml')
    return defaultProfile
  } catch {
    // Bun's TOML parser rejects keys starting with digits (e.g. "0g" in rpc_endpoints).
    // Fall back to regex extraction of [profile.default] values.
    const extract = (key: string): string | undefined =>
      content.match(
        new RegExp(`^\\[profile\\.default\\][\\s\\S]*?^${key}\\s*=\\s*['"]([^'"]+)['"]`, 'm')
      )?.[1]

    const solc_version = extract('solc_version')
    const evm_version = extract('evm_version')

    if (!solc_version && !evm_version)
      throw new Error('Missing [profile.default] section in foundry.toml')

    return { solc_version, evm_version } as IFoundryProfileDefaultConfig
  }
}

/**
 * Returns `solc_version` from `[profile.default]` in `foundry.toml` (e.g. `0.8.29`).
 * @throws If `foundry.toml` cannot be read or `solc_version` is missing.
 */
export function getFoundryDefaultSolcVersion(): string {
  try {
    const solcVersion = readFoundryProfileDefaultConfig().solc_version?.trim()
    if (!solcVersion)
      throw new Error('Missing [profile.default].solc_version in foundry.toml')
    return solcVersion
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to determine SOLC version from foundry.toml: ${message}`
    )
  }
}

/**
 * Returns `evm_version` from `[profile.default]` in `foundry.toml`, validated against `EVM_VERSIONS`
 * in `constants.ts`.
 * @throws If `foundry.toml` cannot be read, `evm_version` is missing, or the value is unsupported.
 */
export function getFoundryDefaultEvmVersion(): EVMVersion {
  try {
    const evmVersion = readFoundryProfileDefaultConfig()
      .evm_version?.trim()
      .toLowerCase()
    if (!evmVersion)
      throw new Error('Missing [profile.default].evm_version in foundry.toml')
    if ((EVM_VERSIONS as readonly string[]).includes(evmVersion))
      return evmVersion as EVMVersion
    throw new Error(
      `foundry.toml evm_version '${evmVersion}' is not in known EVM_VERSIONS`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Failed to determine EVM version from foundry.toml: ${message}`
    )
  }
}

/**
 * Returns the `networks.json` config entry for a given network name.
 * @throws If the network name is not present in `config/networks.json`.
 */
export function getNetworkConfig(networkName: string): Omit<INetwork, 'id'> {
  const networkConfig = networks[networkName]
  if (!networkConfig)
    throw new Error(`Network configuration not found for: ${networkName}`)
  return networkConfig
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
 * Get deployment environment from .env
 */
export function getEnvironment(): EnvironmentEnum {
  return process.env.PRODUCTION === 'true'
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
 * Returns the signing private key for the current deployment environment.
 * Reads environment from `.env` via {@link getEnvironment}, then reads
 * `PRIVATE_KEY_PRODUCTION` or `PRIVATE_KEY` (same semantics as `getPrivateKeyForEnvironment` in `demoScriptHelpers.ts`).
 */
export async function getPrivateKey(): Promise<string> {
  const environment = getEnvironment()
  const name =
    environment === EnvironmentEnum.production
      ? 'PRIVATE_KEY_PRODUCTION'
      : 'PRIVATE_KEY'
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

/**
 * Appends a deployment entry to the JSON log file by calling `logDeployment` in `helperFunctions.sh`.
 * Reads the current environment from `.env` to determine whether to write to the production or staging log.
 *
 * @param contract - Contract name (e.g. `'LiFiDiamond'`).
 * @param network - Network key from `config/networks.json`.
 * @param address - Deployed contract address (Tron base58 format).
 * @param version - Contract version string.
 * @param constructorArgs - ABI-encoded constructor arguments (empty string if none).
 * @param verified - Whether the contract has been verified on the explorer (default: `false`).
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
  const environment = getEnvironment()

  // Escape shell arguments to prevent injection
  const escapeShellArg = (arg: string) => `'${arg.replace(/'/g, "'\"'\"'")}'`

  const environmentString =
    environment === EnvironmentEnum.production ? 'production' : 'staging'
  const solcVersion = getFoundryDefaultSolcVersion()
  const evmVersion = getFoundryDefaultEvmVersion()
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
    escapeShellArg(solcVersion),
    escapeShellArg(evmVersion),
    escapeShellArg(''),
  ].join(' ')

  await executeShellCommand(logCommand)
}

/**
 * Writes a contract address to the environment-appropriate deployment JSON file
 * (`deployments/<network>.json` or `deployments/<network>.staging.json`).
 * Uses {@link pickDeploymentRootForWrites} to resolve the correct directory when running
 * from a parent workspace path.
 */
export async function saveContractAddress(
  network: SupportedChain,
  contract: string,
  address: string
): Promise<void> {
  const environment = getEnvironment()
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
 * Tries env-specific file first, then base network file; also tries alternate roots (e.g. cwd vs cwd/contracts).
 */
export async function getContractAddress(
  network: SupportedChain,
  contract: string
): Promise<string | null> {
  const environment = getEnvironment()
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
 * Writes facet deployment info to the `<network>.diamond.json` file.
 * Each facet is keyed by its deployed address with `Name` and `Version` sub-fields.
 * Creates the file with an empty `Periphery` section if it does not exist.
 */
export async function saveDiamondDeployment(
  network: SupportedChain,
  _diamondAddress: string,
  facets: Record<string, { address: string; version: string }>
): Promise<void> {
  const environment = getEnvironment()
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
 * Normalize selector to Hex format (ensure 0x prefix)
 */
export function normalizeSelector(selector: string): Hex {
  return selector.startsWith('0x')
    ? (selector as Hex)
    : (`0x${selector}` as Hex)
}

/**
 * Update diamond.json with registered facet information
 * @param facetAddress - The address of the facet (base58 format for Tron)
 * @param facetName - The name of the facet (e.g., 'SymbiosisFacet')
 * @param version - The version of the facet (optional, will try to get from contract)
 * @param network - The network name (defaults to 'tron')
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
 * Update diamond.json with multiple facets at once
 * @param facetEntries - Array of {address, name, version?} objects
 * @param network - The network name (defaults to 'tron')
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
        consola.info(`${entry.name} already exists in ${network}.diamond.json`)
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
 * Update diamond.json with periphery contract information
 * @param contractAddress - The address of the contract (base58 format for Tron)
 * @param contractName - The name of the contract (e.g., 'ERC20Proxy')
 * @param network - The network name (defaults to 'tron')
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
      `WARNING: This will deploy to ${network} ${networkName} in PRODUCTION!`
    )
  else consola.warn(`This will deploy to ${network} ${networkName} in STAGING!`)

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
      if (r.cost > 0) summaryContent += `    Cost: ${r.cost.toFixed(4)}\n`
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
Balance: ${networkInfo.balance}
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
