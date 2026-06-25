/**
 * Demo script for bridging tokens via the LayerSwapFacet.
 *
 * ######### !!!!!!!!!!!!!!!! IMPORTANT INFORMATION !!!!!!!!!!!!!!!! #########
 * This script assumes that we get access to the backend STAGING signer private key for testing.
 * please add this to your .env with:
 * PRIVATE_KEY_BACKEND_SIGNER_STAGING=<private key>
 * ######### !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!! #########
 *
 * Source chain is fixed to Arbitrum (arbitrum.staging.json deployments).
 * Destination chain is passed as a LayerSwap network name; the LiFi chain ID
 * is resolved locally via NETWORK_TO_CHAIN_ID.
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
 *     [--to <LAYERSWAP_NETWORK>] \
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
  isHex,
  parseUnits,
  toHex,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
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
//   - src: http://arbiscan.io/tx/0xf2b7dd467fab54262b8cd3a35acacbc56996ccc5faa1f26878312f2361243013
//   - dst: https://basescan.org/tx/0x20fba63bd60caba26d0474ad2daf6a6f0d1550f2ea1e6456ce567a284dad4d13
// Bridge 0.00002 ETH from Arbitrum to Base:
//   - src: https://arbiscan.io/tx/0x2e4095c71da57ac4c6d0ece4f93934dd2896b06b3a53d50b8948beb14d0df3e9
//   - dst: https://basescan.org/tx/0x9867c43f5faa28fc11a26ce635790b233747c9929d4f949340fccb41b8ee4141
// Bridge 0.25 USDC from Arbitrum to Solana:
//   - src: https://arbiscan.io/tx/0x55bf753eff3ab98897ddd0fcc1f99bcbef1b5a1261f2db199662c84a8e73e25d
//   - dst: https://solscan.io/tx/2Eeq1bTvSPMy8x7XWSsZjdAANhV3ikvNXghz1CjjM8sXi9sgW8gqxQ9jD95QJiRqKXYMTFBkpGiMPxfB9uuGLmsb

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

interface IScriptArgs {
  to: string
  token: string
  amount?: string
  receiver?: string
}

const parseArgs = (): IScriptArgs => {
  const argv = process.argv.slice(2)
  const getOpt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  return {
    to: (getOpt('to') ?? 'ETHEREUM_MAINNET').toUpperCase(),
    token: (getOpt('token') ?? 'USDC').toUpperCase(),
    amount: getOpt('amount'),
    receiver: getOpt('receiver'),
  }
}

interface ILayerSwapDepositAction {
  to_address: string
  encoded_args: string[]
  token: { symbol: string; decimals: number; contract: string | null }
}

interface ILayerSwapCreateSwapResponse {
  data: {
    swap: { id: string }
    deposit_actions: ILayerSwapDepositAction[]
  }
}

interface ICreateSwapParams {
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
  params: ICreateSwapParams
): Promise<ILayerSwapDepositAction> => {
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

  const json = (await response.json()) as ILayerSwapCreateSwapResponse
  const deposit = json.data.deposit_actions?.[0]
  if (!deposit) throw new Error('LayerSwap response missing deposit_actions[0]')
  return deposit
}

/**
 * Resolves the LiFi destination chain ID from a LayerSwap network name.
 * Throws if the network is not in NETWORK_TO_CHAIN_ID.
 */
const resolveDestinationChainId = (network: string): number | bigint => {
  const mapped = NETWORK_TO_CHAIN_ID[network]
  if (mapped !== undefined) return mapped

  throw new Error(
    `Unknown destination network "${network}". ` +
      `Add the network to NETWORK_TO_CHAIN_ID.`
  )
}

const main = async () => {
  const args = parseArgs()
  const isSolana = args.to === SOLANA_NETWORK
  const isNative = args.token === 'ETH'
  const amountHuman = args.amount ?? (isNative ? '0.0001' : '1')
  const destinationChainId = resolveDestinationChainId(args.to)

  // Setup viem clients via shared helper (null ABI so we create the
  // typed contract ourselves, preserving the full ABI type)
  const { publicClient, walletClient, walletAccount, client } =
    await setupEnvironment('arbitrum', null, EnvironmentEnum.staging)
  const callerAddress = walletAccount.address

  const deployments = await import('../../deployments/arbitrum.staging.json')
  const diamondAddress = getAddress(deployments.LiFiDiamond)

  const layerSwapFacet = getContract({
    address: diamondAddress,
    abi: LayerSwapFacet__factory.abi,
    client,
  })

  // Split receiver by chain family: EVM address goes into bridgeData /
  // EIP-712 payload; Solana base58 is only used for the LayerSwap API and
  // for deriving the non-EVM receiver bytes32.
  const privateKey = getPrivateKeyForEnvironment(EnvironmentEnum.staging)
  const solanaReceiverBase58 = isSolana
    ? args.receiver ?? deriveSolanaAddress(privateKey)
    : ''
  const evmReceiver: Address = isSolana
    ? NON_EVM_ADDRESS
    : getAddress(args.receiver ?? callerAddress)
  const apiDestinationAddress = isSolana ? solanaReceiverBase58 : evmReceiver

  consola.info('=== LayerSwapFacet Demo ===')
  consola.info('From:    ARBITRUM_MAINNET')
  consola.info(`To:      ${args.to}`)
  consola.info(`Token:   ${args.token}`)
  consola.info(`Amount:  ${amountHuman}`)
  consola.info(`Caller:  ${callerAddress}`)
  consola.info(`Receiver:${apiDestinationAddress}`)

  // 1. Register swap with LayerSwap
  const deposit = await createLayerSwapSwap({
    source_network: 'ARBITRUM_MAINNET',
    source_token: args.token,
    destination_network: args.to,
    destination_token: args.token,
    destination_address: apiDestinationAddress,
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
  const [rawRequestId, ...rest] = deposit.encoded_args
  const rawReceiver = isNative ? rest[0] : rest[1]
  if (!rawRequestId || !rawReceiver)
    throw new Error('LayerSwap encoded_args missing required fields')
  if (!isHex(rawRequestId))
    throw new Error(`LayerSwap requestId is not hex: ${rawRequestId}`)
  const requestId: Hex = rawRequestId
  const depositoryReceiver = getAddress(rawReceiver)

  consola.info(`\nLayerSwap depository: ${deposit.to_address}`)
  consola.info(`Request ID:           ${requestId}`)
  consola.info(`Depository receiver:  ${depositoryReceiver}`)

  // 2. Build bridge params (source asset info comes from the API response)
  const sendingAssetId: Address = isNative
    ? zeroAddress
    : getAddress(
        deposit.token.contract ??
          (() => {
            throw new Error(
              `LayerSwap did not return a contract address for ${args.token} on ARBITRUM_MAINNET`
            )
          })()
      )
  const amount = parseUnits(amountHuman, isNative ? 18 : deposit.token.decimals)

  const transactionId = toHex(new Uint8Array(randomBytes(32)))

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId,
    bridge: 'layerSwap',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId,
    receiver: evmReceiver,
    minAmount: amount,
    destinationChainId,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // 3. Sign the LayerSwapPayload via EIP-712
  const backendSignerKey = getEnvVar('PRIVATE_KEY_BACKEND_SIGNER_STAGING')
  const normalizedKey: Hex = backendSignerKey.startsWith('0x')
    ? (backendSignerKey as Hex)
    : (`0x${backendSignerKey}` as Hex)
  const backendSignerAccount = privateKeyToAccount(normalizedKey)

  const sourceChainId = await publicClient.getChainId()
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)

  const nonEVMReceiver: Hex = isSolana
    ? solanaAddressToBytes32(solanaReceiverBase58)
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
      receiver: evmReceiver,
      requestId,
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
    await ensureBalance(tokenContract, callerAddress, amount, publicClient)
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
            args: [ILiFi.BridgeDataStruct, LayerSwapFacet.LayerSwapDataStruct],
            options?: { value: bigint }
          ) => Promise<Hex>
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
