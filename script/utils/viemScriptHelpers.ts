import {
  Chain,
  defineChain,
  encodeFunctionData,
  getAddress,
  parseAbi,
} from 'viem'
import networksConfig from '../../config/networks.json'
import * as dotenv from 'dotenv'
import * as path from 'path'
import * as fs from 'fs'
import consola from 'consola'
import { privateKeyToAccount } from 'viem/accounts'
import { createWalletClient, http, createPublicClient } from 'viem'
import {
  getNextNonce,
  getSafeMongoCollection,
  initializeSafeClient,
  OperationType,
  storeTransactionInMongoDB,
} from '../deploy/safe/safe-utils'
import type { Address, Hex } from 'viem'
dotenv.config()

export type NetworksObject = {
  [key: string]: Omit<Network, 'id'>
}

export type Network = {
  name: string
  chainId: number
  nativeAddress: string
  nativeCurrency: string
  wrappedNativeAddress: string
  status: string
  type: string
  rpcUrl: string
  verificationType: string
  explorerUrl: string
  explorerApiUrl: string
  multicallAddress: string
  safeApiUrl: string
  safeAddress: string
  safeWebUrl: string
  gasZipChainId: number
  id: string
}

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
}

export const networks: NetworksObject = networksConfig

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

export const getAllNetworksArray = (): Network[] => {
  // Convert the object into an array of network objects
  const networkArray = Object.entries(networksConfig).map(([key, value]) => ({
    ...value,
    id: key,
  }))

  return networkArray
}

// removes all networks with "status='inactive'"
export const getAllActiveNetworks = (): Network[] => {
  // Convert the object into an array of network objects
  const networkArray = getAllNetworksArray()

  // Example: Filter networks where status is 'active'
  const activeNetworks: Network[] = networkArray.filter(
    (network) => network.status === 'active'
  )

  return activeNetworks
}

export const printSuccess = (message: string): void => {
  if (!message?.trim()) return
  console.log(`${colors.green}${message}${colors.reset}`)
}

/**
 * Extracts and ABI-encodes function selectors for a given contract, excluding optional ones.
 *
 * @param contractName Name of the contract (without .sol)
 * @param excludes Optional array of selectors to exclude (e.g., ['0x12345678'])
 * @returns Hex-encoded calldata array like cast abi-encode would produce
 */
export function getFunctionSelectors(
  contractName: string,
  excludes: string[] = []
): `0x${string}`[] {
  const filePath = path.resolve(
    `./out/${contractName}.sol/${contractName}.json`
  )

  if (!fs.existsSync(filePath)) {
    throw new Error(`Contract JSON not found at path: ${filePath}`)
  }

  const raw = fs.readFileSync(filePath, 'utf8')
  const json = JSON.parse(raw)
  const identifiers = json?.methodIdentifiers

  if (!identifiers) {
    throw new Error(`No methodIdentifiers found in contract: ${contractName}`)
  }

  const excludesClean = excludes.map((sel) =>
    sel.replace(/^0x/, '').toLowerCase()
  )

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

  if (!fs.existsSync(filePath)) {
    throw new Error(`Deploy log not found: ${filePath}`)
  }

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

/**
 * Sends the calldata directly to the Diamond (if staging or override enabled),
 * or proposes it to the Safe (if production).
 */
export async function sendOrPropose({
  calldata,
  network,
  environment,
  diamondAddress,
}: {
  calldata: `0x${string}`
  network: string
  environment: 'staging' | 'production'
  diamondAddress: string
}) {
  const isProd = environment === 'production'
  const sendDirectly =
    environment === 'staging' ||
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === 'true'

  // ───────────── DIRECT TX FLOW ───────────── //
  if (sendDirectly) {
    consola.info('📤 Sending transaction directly to the Diamond...')

    const pk = process.env[isProd ? 'PRIVATE_KEY_PRODUCTION' : 'PRIVATE_KEY']
    if (!pk) throw new Error('Missing private key in environment')

    // add 0x to privKey, if not there already
    const normalizedPk = pk.startsWith('0x') ? pk : `0x${pk}`
    const account = privateKeyToAccount(normalizedPk as `0x${string}`)

    const chain = getViemChainForNetworkName(network)

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(),
    })

    // Use PublicClient to wait for tx
    const publicClient = createPublicClient({
      chain,
      transport: http(),
    })

    const hash = await walletClient
      .sendTransaction({
        to: getAddress(diamondAddress),
        data: calldata,
      })
      .catch((err) => {
        consola.error('❌ Failed to broadcast tx:', err)
        throw err
      })

    consola.info(`⏳ Waiting for tx ${hash} to be mined...`)

    const receipt = await publicClient.waitForTransactionReceipt({ hash })

    if (receipt.status !== 'success')
      throw new Error(`Tx reverted in block ${receipt.blockNumber}`)

    consola.success(`✅ Tx confirmed in block ${receipt.blockNumber}`)

    return
  }

  // ───────────── SAFE PROPOSAL FLOW ───────────── //
  const pk = process.env.SAFE_SIGNER_PRIVATE_KEY
  if (!pk) throw new Error('Missing SAFE_SIGNER_PRIVATE_KEY in environment')

  const { safe, chain, safeAddress } = await initializeSafeClient(network, pk)
  consola.info(`🔐 Proposing transaction to Safe ${safeAddress}`)

  const { client: mongoClient, pendingTransactions } =
    await getSafeMongoCollection()

  const currentSafeNonce = await safe.getNonce()

  const nextNonce = await getNextNonce(
    pendingTransactions,
    safeAddress,
    network,
    chain.id,
    currentSafeNonce
  )

  const safeTransaction = await safe.createTransaction({
    transactions: [
      {
        to: diamondAddress as Address,
        value: 0n,
        data: calldata as Hex,
        operation: OperationType.Call,
        nonce: nextNonce,
      },
    ],
  })

  const signedTx = await safe.signTransaction(safeTransaction)
  const safeTxHash = await safe.getTransactionHash(signedTx)

  consola.info('📝 Safe Address:', safeAddress)
  consola.info('🧾 Safe Tx Hash:', safeTxHash)

  try {
    const result = await storeTransactionInMongoDB(
      pendingTransactions,
      safeAddress,
      network,
      chain.id,
      signedTx,
      safeTxHash,
      safe.account
    )

    if (!result.acknowledged) {
      throw new Error('MongoDB insert was not acknowledged')
    }

    consola.success('✅ Safe transaction proposed and stored in MongoDB')
  } catch (err) {
    consola.error('❌ Failed to store transaction in MongoDB:', err)
    await mongoClient.close()
    throw new Error(`Failed to store transaction in MongoDB: ${err.message}`)
  }

  await mongoClient.close()
}
