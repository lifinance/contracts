/**
 * Demo script for bridging tokens via the LayerSwapFacet.
 *
 * Source chain is fixed to Arbitrum (arbitrum.staging.json deployments).
 * Destination chain is passed directly to the LayerSwap API as a network name.
 *
 * Flow:
 *   1. POST /api/v2/swaps with use_depository=true.
 *   2. Response deposit_actions[0] provides:
 *        - to_address       = LayerSwap depository contract
 *        - encoded_args     = native: [requestId, receiver]
 *                             ERC20:  [requestId, token, receiver, amount]
 *        - token.contract   = ERC20 contract on the source chain (null for native)
 *   3. For ERC20, approve the diamond. Then call
 *      startBridgeTokensViaLayerSwap on the diamond.
 *
 * Usage:
 *   bun script/demoScripts/demoLayerSwap.ts \
 *     [--to <LAYERSWAP_NETWORK>] [--chainId <id>] \
 *     [--token <symbol>] [--amount <number>] [--receiver <address>]
 *
 * Defaults: --to ETHEREUM_MAINNET --token USDC --amount 1 (ERC20) / 0.0001 (ETH)
 *           --receiver caller's EVM address (or derived Solana address
 *                      when --to SOLANA_MAINNET)
 *
 * LayerSwap integration docs: https://docs.layerswap.io/lifi-integration
 */

import { randomBytes } from 'crypto'

import { consola } from 'consola'
import { config } from 'dotenv'
import {
  getAddress,
  getContract,
  parseUnits,
  toHex,
  zeroAddress,
  zeroHash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { ERC20__factory, LayerSwapFacet__factory } from '../../typechain'
import type { ILiFi, LayerSwapFacet } from '../../typechain'
import { EnvironmentEnum } from '../common/types'
import { fetchWithTimeout } from '../utils/fetchWithTimeout'

import { getEnvVar } from '../utils/utils'

import {
  createContractObject,
  deriveSolanaAddress,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getPrivateKeyForEnvironment,
  LIFI_CHAIN_ID_SOLANA,
  NON_EVM_ADDRESS,
  setupEnvironment,
  solanaAddressToBytes32,
} from './utils/demoScriptHelpers'

config()

// SUCCESSFUL TRANSACTIONS PRODUCED BY THIS SCRIPT ---
// Bridge 0.1 USDC from Arbitrum to Base:
//   - src: http://arbiscan.io/tx/
//   - dst: https://basescan.org/tx/0xd8df1d5613684b62e50884c985252f1e4b87e8eb1490bc4935181b3a416602fa
// Bridge 0.00002 ETH from Arbitrum to Base:
//   - src: https://arbiscan.io/tx/0xedc0c7f3ee67a4b1a828ae6bc7dd518fea6957c896292a2ac8294f3f710c43ba
//   - dst: https://basescan.org/tx/0x4e964a735159e2e36a67bfe348a5a36463fc330958294234e55d0b264e0d80b2
// Bridge 0.25 USDC from Arbitrum to Solana:
//   - src: https://arbiscan.io/tx/0x82d3b2f6d00b016f7f193d55fd59141ace7987a189be32fbb672c01cdb9fcf4f
//   - dst: https://solscan.io/tx/Vmnez41Kp14KrpSRkFCBwbjfjTYN6MCUx4fLe4G61EAfj89ynKvP9TtcfLUkPQE7osz3s6qfDCb8a7S3FAb5dzt

const LAYERSWAP_API = 'https://api.layerswap.io/api/v2/swaps'
const SOLANA_NETWORK = 'SOLANA_MAINNET'

/** Maps LayerSwap network names to LiFi chain IDs. */
const NETWORK_TO_CHAIN_ID: Record<string, number | bigint> = {
  ETHEREUM_MAINNET: 1,
  ARBITRUM_MAINNET: 42161,
  OPTIMISM_MAINNET: 10,
  BASE_MAINNET: 8453,
  POLYGON_MAINNET: 137,
  BSC_MAINNET: 56,
  AVALANCHE_MAINNET: 43114,
  LINEA_MAINNET: 59144,
  SCROLL_MAINNET: 534352,
  ZKSYNC_MAINNET: 324,
  SOLANA_MAINNET: LIFI_CHAIN_ID_SOLANA,
}

interface ScriptArgs {
  to: string
  chainId?: string
  token: string
  amount?: string
  receiver?: string
}

const parseArgs = (): ScriptArgs => {
  const argv = process.argv.slice(2)
  const getOpt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  return {
    to: (getOpt('to') ?? 'ETHEREUM_MAINNET').toUpperCase(),
    chainId: getOpt('chainId'),
    token: (getOpt('token') ?? 'USDC').toUpperCase(),
    amount: getOpt('amount'),
    receiver: getOpt('receiver'),
  }
}

interface LayerSwapDepositAction {
  to_address: string
  encoded_args: string[]
  token: { symbol: string; decimals: number; contract: string | null }
}

interface LayerSwapCreateSwapResponse {
  data: {
    swap: { id: string }
    deposit_actions: LayerSwapDepositAction[]
  }
}

interface CreateSwapParams {
  source_network: string
  source_token: string
  destination_network: string
  destination_token: string
  destination_address: string
  source_address: string
  amount: number
  use_depository: boolean
}

const createLayerSwapSwap = async (
  params: CreateSwapParams
): Promise<LayerSwapDepositAction> => {
  const response = await fetchWithTimeout(LAYERSWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `LayerSwap POST /swaps failed: ${response.status} ${errorBody}`
    )
  }

  const json = (await response.json()) as LayerSwapCreateSwapResponse
  const deposit = json.data.deposit_actions?.[0]
  if (!deposit)
    throw new Error('LayerSwap response missing deposit_actions[0]')
  return deposit
}

/**
 * Resolves the LiFi destination chain ID from CLI args and network name.
 * Explicit --chainId takes priority. Otherwise the network name is looked up
 * in NETWORK_TO_CHAIN_ID. Throws if neither resolves.
 */
const resolveDestinationChainId = (
  args: ScriptArgs
): number | bigint => {
  if (args.chainId) return Number(args.chainId)

  const mapped = NETWORK_TO_CHAIN_ID[args.to]
  if (mapped !== undefined) return mapped

  throw new Error(
    `Unknown destination network "${args.to}". ` +
      `Pass --chainId explicitly or add the network to NETWORK_TO_CHAIN_ID.`
  )
}

const main = async () => {
  const args = parseArgs()
  const isSolana = args.to === SOLANA_NETWORK
  const isNative = args.token === 'ETH'
  const amountHuman = args.amount ?? (isNative ? '0.0001' : '1')
  const destinationChainId = resolveDestinationChainId(args)

  // Setup viem clients via shared helper (null ABI so we create the
  // typed contract ourselves, preserving the full ABI type)
  const { publicClient, walletClient, walletAccount, client } =
    await setupEnvironment('arbitrum', null, EnvironmentEnum.staging)
  const callerAddress = walletAccount.address

  const deployments = await import(
    '../../deployments/arbitrum.staging.json'
  )
  const diamondAddress = getAddress(deployments.LiFiDiamond)

  const layerSwapFacet = getContract({
    address: diamondAddress,
    abi: LayerSwapFacet__factory.abi,
    client,
  })

  // Derive Solana receiver from signer key when bridging to Solana
  const privateKey = getPrivateKeyForEnvironment(EnvironmentEnum.staging)
  const solanaReceiverBase58 = isSolana
    ? deriveSolanaAddress(privateKey)
    : ''
  const receiver =
    args.receiver ??
    (isSolana ? solanaReceiverBase58 : callerAddress)

  consola.info('=== LayerSwapFacet Demo ===')
  consola.info('From:    ARBITRUM_MAINNET')
  consola.info(`To:      ${args.to}`)
  consola.info(`Token:   ${args.token}`)
  consola.info(`Amount:  ${amountHuman}`)
  consola.info(`Caller:  ${callerAddress}`)
  consola.info(`Receiver:${receiver}`)

  // 1. Register swap with LayerSwap
  const deposit = await createLayerSwapSwap({
    source_network: 'ARBITRUM_MAINNET',
    source_token: args.token,
    destination_network: args.to,
    destination_token: args.token,
    destination_address: receiver,
    source_address: callerAddress,
    amount: Number(amountHuman),
    use_depository: true,
  })

  // Native: [requestId, receiver]
  // ERC20:  [requestId, token, receiver, amount]
  const expectedLength = isNative ? 2 : 4
  if (deposit.encoded_args.length !== expectedLength)
    throw new Error(
      `LayerSwap encoded_args has ${deposit.encoded_args.length} entries (expected ${expectedLength})`
    )
  const [requestId, ...rest] = deposit.encoded_args
  const rawReceiver = isNative ? rest[0] : rest[1]
  if (!requestId || !rawReceiver)
    throw new Error('LayerSwap encoded_args missing required fields')
  const depositoryReceiver = getAddress(rawReceiver)

  consola.info(`\nLayerSwap depository: ${deposit.to_address}`)
  consola.info(`Request ID:           ${requestId}`)
  consola.info(`Depository receiver:  ${depositoryReceiver}`)

  // 2. Build bridge params (source asset info comes from the API response)
  const sendingAssetId = isNative
    ? zeroAddress
    : getAddress(
        deposit.token.contract ??
          (() => {
            throw new Error(
              `LayerSwap did not return a contract address for ${args.token} on ARBITRUM_MAINNET`
            )
          })()
      )
  const amount = parseUnits(
    amountHuman,
    isNative ? 18 : deposit.token.decimals
  )

  const transactionId = toHex(new Uint8Array(randomBytes(32)))

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId,
    bridge: 'layerSwap',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId,
    receiver: isSolana ? NON_EVM_ADDRESS : receiver,
    minAmount: amount,
    destinationChainId,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // 3. Sign the LayerSwapPayload via EIP-712
  const backendSignerKey = getEnvVar('PRIVATE_KEY_BACKEND_SIGNER_STAGING')
  const normalizedKey: `0x${string}` = backendSignerKey.startsWith('0x')
    ? (backendSignerKey as `0x${string}`)
    : (`0x${backendSignerKey}` as `0x${string}`)
  const backendSignerAccount = privateKeyToAccount(normalizedKey)

  const sourceChainId = await publicClient.getChainId()
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

  const nonEVMReceiver = isSolana
    ? solanaAddressToBytes32(receiver)
    : zeroHash

  const backendSignature = await backendSignerAccount.signTypedData({
    domain: {
      name: 'LI.FI LayerSwap Facet',
      version: '1',
      chainId: sourceChainId,
      verifyingContract: diamondAddress,
    },
    types: {
      LayerSwapPayload: [
        { name: 'transactionId', type: 'bytes32' },
        { name: 'minAmount', type: 'uint256' },
        { name: 'receiver', type: 'address' },
        { name: 'requestId', type: 'bytes32' },
        { name: 'depositoryReceiver', type: 'address' },
        { name: 'nonEVMReceiver', type: 'bytes32' },
        { name: 'destinationChainId', type: 'uint256' },
        { name: 'sendingAssetId', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'LayerSwapPayload',
    message: {
      transactionId,
      minAmount: amount,
      receiver: isSolana ? NON_EVM_ADDRESS : receiver,
      requestId: requestId as `0x${string}`,
      depositoryReceiver,
      nonEVMReceiver,
      destinationChainId: BigInt(destinationChainId),
      sendingAssetId,
      deadline,
    },
  })

  consola.info(`\nBackend signer:  ${backendSignerAccount.address}`)
  consola.info(`Deadline:        ${deadline}`)

  const layerSwapData: LayerSwapFacet.LayerSwapDataStruct = {
    requestId,
    depositoryReceiver,
    nonEVMReceiver,
    signature: backendSignature,
    deadline,
  }

  // 4. Approve (ERC20 only) and bridge
  if (!isNative) {
    consola.info('\nChecking balance and allowance...')
    const tokenContract = createContractObject(
      sendingAssetId,
      ERC20__factory.abi,
      publicClient,
      walletClient
    )
    await ensureBalance(
      tokenContract,
      callerAddress,
      amount,
      publicClient
    )
    await ensureAllowance(
      tokenContract,
      callerAddress,
      diamondAddress,
      amount,
      publicClient
    )
  }

  consola.info(`\nBridging ${args.token} via LayerSwap...`)

  const hash = await executeTransaction(
    () =>
      (
        layerSwapFacet.write as {
          startBridgeTokensViaLayerSwap: (
            args: [
              ILiFi.BridgeDataStruct,
              LayerSwapFacet.LayerSwapDataStruct
            ],
            options?: { value: bigint }
          ) => Promise<`0x${string}`>
        }
      ).startBridgeTokensViaLayerSwap(
        [bridgeData, layerSwapData],
        isNative ? { value: amount } : undefined
      ),
    'Bridge tokens via LayerSwap',
    publicClient,
    true
  )

  consola.info('Bridge transaction confirmed')
  consola.info(`Transaction hash: ${hash}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    consola.error('\nDemo failed')
    consola.error(error)
    process.exit(1)
  })
