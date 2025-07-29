import { resolve } from 'path'

import globalConfig from '../../../config/global.json'
import networks from '../../../config/networks.json'

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

    console.log(`📁 Loaded ${contractName} from: ${artifactPath}`)
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

  if (environment === 'production') {
    const privateKey = process.env.PRIVATE_KEY_PRODUCTION
    if (!privateKey)
      throw new Error('PRIVATE_KEY_PRODUCTION not found in .env file')

    return privateKey
  } else {
    const privateKey = process.env.PRIVATE_KEY
    if (!privateKey) throw new Error('PRIVATE_KEY not found in .env file')

    return privateKey
  }
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
