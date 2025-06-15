import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import * as dotenv from 'dotenv'
import {
  defineChain,
  encodeFunctionData,
  getAddress,
  parseAbi,
  type Chain,
} from 'viem'

import networksConfig from '../../config/networks.json'
import {
  EnvironmentEnum,
  type SupportedChain,
  type INetwork,
  type INetworksObject,
} from '../common/types'

import { getDeployments } from './deploymentHelpers'

dotenv.config()

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
}

export const networks: INetworksObject = networksConfig

export const getViemChainForNetworkName = (networkName: string): Chain => {
  const network = networks[networkName]

  if (!network)
    throw new Error(
      `Chain ${networkName} does not exist. Please check that the network exists in 'config/networks.json'`
    )

  // Construct the environment variable key dynamically
  const envKey = `ETH_NODE_URI_${networkName.toUpperCase()}`
  const rpcUrl = process.env[envKey] || network.rpcUrl // Use .env value if available, otherwise fallback

  if (!rpcUrl)
    throw new Error(
      `Could not find RPC URL for network ${networkName}, please add one with the key ${envKey} to your .env file`
    )

  const chain = defineChain({
    id: network.chainId,
    name: network.name,
    nativeCurrency: {
      decimals: 18,
      name: network.nativeCurrency,
      symbol: network.nativeCurrency,
    },
    rpcUrls: {
      default: {
        http: [rpcUrl],
      },
    },
    contracts: {
      multicall3: { address: getAddress(network.multicallAddress) },
    },
  })
  return chain
}

export const getAllNetworksArray = (): INetwork[] => {
  // Convert the object into an array of network objects
  const networkArray = Object.entries(networksConfig).map(([key, value]) => ({
    ...value,
    id: key,
  }))

  return networkArray
}

// removes all networks with "status='inactive'"
export const getAllActiveNetworks = (): INetwork[] => {
  // Convert the object into an array of network objects
  const networkArray = getAllNetworksArray()

  // Example: Filter networks where status is 'active'
  const activeNetworks: INetwork[] = networkArray.filter(
    (network) => network.status === 'active'
  )

  return activeNetworks
}

export const printSuccess = (message: string): void => {
  if (!message?.trim()) return
  console.log(`${colors.green}${message}${colors.reset}`)
}

/**
 * Retries a function multiple times if it fails
 * @param func - The async function to retry
 * @param retries - Number of retries remaining
 * @returns The result of the function
 */
export const retry = async <T>(
  func: () => Promise<T>,
  retries = 3
): Promise<T> => {
  try {
    const result = await func()
    return result
  } catch (e) {
    consola.error('Error details:', {
      error: e,
      remainingRetries: retries - 1,
    })
    if (retries > 0) return retry(func, retries - 1)

    throw e
  }
}

/**
 * Returns
 * @param func - The async function to retry
 * @param retries - Number of retries remaining
 * @returns The result of the function
 */
export const getContractAddressForNetwork = async (
  contractName: string,
  network: SupportedChain,
  environment: EnvironmentEnum = EnvironmentEnum.production
): Promise<string> => {
  // get network deploy log file
  const deployments = await getDeployments(network, environment)
  if (!deployments)
    throw Error(`Could not deploy log for network ${network} in ${environment}`)

  // extract address
  const address = deployments[contractName] as `0x${string}`

  if (!address)
    throw Error(
      `Could not find address of contract ${contractName} for network ${network} in ${environment} deploy log`
    )

  return address
}

/**
 * Extracts the function selectors (method IDs) from the contract's ABI JSON output.
 *
 * @param contractName - Name of the contract (used to locate the compiled JSON)
 * @param excludes - Optional list of function selectors (with or without '0x') to exclude
 * @returns An array of function selectors as strings prefixed with '0x'
 */
export function getFunctionSelectors(
  contractName: string,
  excludes: string[] = []
): `0x${string}`[] {
  // Build the file path to the contract's compiled JSON file
  const filePath = path.resolve(
    `./out/${contractName}.sol/${contractName}.json`
  )

  // Ensure the contract file exists
  if (!fs.existsSync(filePath))
    throw new Error(`Contract JSON not found at path: ${filePath}`)

  // Load and parse the compiled contract JSON
  const raw = fs.readFileSync(filePath, 'utf8')
  const json = JSON.parse(raw)
  const identifiers = json?.methodIdentifiers

  // Ensure methodIdentifiers are present in the JSON (these map function signatures to selectors)
  if (!identifiers)
    throw new Error(`No methodIdentifiers found in contract: ${contractName}`)

  // Clean the exclusion list (remove '0x' prefix and lowercase them for consistent comparison)
  const excludesClean = excludes.map((sel) =>
    sel.replace(/^0x/, '').toLowerCase()
  )

  // Extract all function selectors, filter out excluded ones, and return as 0x-prefixed strings
  return Object.values(identifiers as Record<string, string>)
    .filter(
      (sel) => !excludesClean.includes(sel.replace(/^0x/, '').toLowerCase())
    )
    .map((sel) => `0x${sel.replace(/^0x/, '')}` as `0x${string}`)
}

/**
 * Retrieves a contract address from a (prod or staging) deploy log file
 *
 * @param network Name of the network
 * @param environment the production environment (production/staging)
 * @returns Hex-encoded calldata array like cast abi-encode would produce
 */
export function getDeployLogFile(
  network: string,
  environment: 'production' | 'staging'
): Record<string, string> {
  const suffix = environment === 'production' ? '' : `.${environment}`
  const filePath = path.resolve(`deployments/${network}${suffix}.json`)

  if (!fs.existsSync(filePath))
    throw new Error(`Deploy log not found: ${filePath}`)

  return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
}

/**
 * Builds diamondCut calldata for removal from a diamond
 *
 * @param facets a list of facets to be removed
 * @returns Hex-encoded calldata that removes all facets at once
 */
export function buildDiamondCutRemoveCalldata(
  facets: { name: string; selectors: string[] }[]
): `0x${string}` {
  const diamondCutAbi = parseAbi([
    'function diamondCut((address facetAddress, uint8 action, bytes4[] functionSelectors)[] _diamondCut, address _init, bytes _calldata)',
  ])

  // prepare the diamondCut arguments for each facet to be removed
  const cutArgs = facets.map((facet) => ({
    facetAddress: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    action: 2,
    functionSelectors: facet.selectors.map(
      (sel) => sel as `0x${string}`
    ) as readonly `0x${string}`[],
  }))

  return encodeFunctionData({
    abi: diamondCutAbi,
    functionName: 'diamondCut',
    args: [cutArgs, '0x0000000000000000000000000000000000000000', '0x'],
  })
}

/**
 * Builds calldata to de-register a periphery contract from a diamond
 *
 * @param name the name of the facet to be unregistered
 * @returns Hex-encoded calldata that de-registers a periphery contract
 */
export function buildUnregisterPeripheryCalldata(name: string): `0x${string}` {
  const abi = parseAbi([
    'function registerPeripheryContract(string _name, address _contractAddress)',
  ])

  return encodeFunctionData({
    abi,
    functionName: 'registerPeripheryContract',
    args: [name, '0x0000000000000000000000000000000000000000'],
  })
}
