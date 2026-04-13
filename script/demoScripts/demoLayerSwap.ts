import { config } from 'dotenv'
import { ethers, utils } from 'ethers'

import deployments from '../../deployments/arbitrum.staging.json'
import {
  ERC20__factory,
  LayerSwapFacet__factory,
  type ILiFi,
  type LayerSwapFacet,
} from '../../typechain'

import {
  LIFI_CHAIN_ID_SOLANA,
  NON_EVM_ADDRESS,
  solanaAddressToBytes32,
} from './utils/demoScriptHelpers'

config()

// LayerSwap integration docs: https://docs.layerswap.io/lifi-integration
//
// Source chain is fixed to Arbitrum (arbitrum.staging.json deployments).
// Destination chain is passed through directly to the LayerSwap API.
//
// Usage:
//   bun tsx script/demoScripts/demoLayerSwap.ts \
//     [--to <LAYERSWAP_NETWORK>] [--chainId <id>] \
//     [--token <symbol>] [--amount <number>] [--receiver <address>]
//
// Defaults: --to ETHEREUM_MAINNET --token USDC --amount 1 (ERC20) / 0.0001 (ETH)
//           --chainId 1 (auto-overridden for SOLANA_MAINNET)
//           --receiver caller's EVM address (or a default Solana address
//                      when --to SOLANA_MAINNET)
//
// Flow:
//   1. POST /api/v2/swaps with use_depository=true.
//   2. Response deposit_actions[0] provides:
//        - to_address       = LayerSwap depository contract
//        - encoded_args     = native: [requestId, receiver]
//                             ERC20:  [requestId, token, receiver, amount]
//        - token.contract   = ERC20 contract on the source chain (null for
//                             native)
//   3. For ERC20, approve the diamond. Then call
//      startBridgeTokensViaLayerSwap on the diamond.

const LAYERSWAP_API = 'https://api.layerswap.io/api/v2/swaps'
const SOLANA_NETWORK = 'SOLANA_MAINNET'
const DEFAULT_SOLANA_RECEIVER = 'EoW7FWTdPdZKpd3WAhH98c2HMGHsdh5yhzzEtk1u68Bb'

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
}

const createLayerSwapSwap = async (
  params: CreateSwapParams
): Promise<LayerSwapDepositAction> => {
  const response = await fetch(LAYERSWAP_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...params,
      slippage: '0.5',
      use_depository: true,
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(
      `LayerSwap POST /swaps failed: ${response.status} ${errorBody}`
    )
  }

  const json = (await response.json()) as LayerSwapCreateSwapResponse
  const deposit = json.data.deposit_actions?.[0]
  if (!deposit) throw new Error('LayerSwap response missing deposit_actions[0]')
  return deposit
}

const main = async () => {
  const args = parseArgs()
  const isSolana = args.to === SOLANA_NETWORK
  const isNative = args.token === 'ETH'
  const amountHuman = args.amount ?? (isNative ? '0.0001' : '1')
  const destinationChainId: number | bigint = isSolana
    ? LIFI_CHAIN_ID_SOLANA
    : Number(args.chainId ?? 1)

  const rpcUrl = process.env.ETH_NODE_URI_ARBITRUM
  const privateKey = process.env.PRIVATE_KEY
  if (!rpcUrl) throw new Error('Missing env var ETH_NODE_URI_ARBITRUM')
  if (!privateKey) throw new Error('Missing env var PRIVATE_KEY')

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl)
  const signer = new ethers.Wallet(privateKey, provider)
  const callerAddress = await signer.getAddress()
  const diamondAddress = deployments.LiFiDiamond
  const layerSwap = LayerSwapFacet__factory.connect(diamondAddress, provider)

  const receiver =
    args.receiver ?? (isSolana ? DEFAULT_SOLANA_RECEIVER : callerAddress)

  console.info('=== LayerSwapFacet Demo ===')
  console.info('From:    ARBITRUM_MAINNET')
  console.info(`To:      ${args.to}`)
  console.info(`Token:   ${args.token}`)
  console.info(`Amount:  ${amountHuman}`)
  console.info(`Caller:  ${callerAddress}`)
  console.info(`Receiver:${receiver}`)

  // 1. Register swap with LayerSwap
  const deposit = await createLayerSwapSwap({
    source_network: 'ARBITRUM_MAINNET',
    source_token: args.token,
    destination_network: args.to,
    destination_token: args.token,
    destination_address: receiver,
    source_address: callerAddress,
    amount: Number(amountHuman),
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
  const depositoryReceiver = utils.getAddress(rawReceiver)

  console.info(`\nLayerSwap depository: ${deposit.to_address}`)
  console.info(`Request ID:           ${requestId}`)
  console.info(`Depository receiver:  ${depositoryReceiver}`)

  // 2. Build bridge params (source asset info comes from the API response)
  const sendingAssetId = isNative
    ? ethers.constants.AddressZero
    : utils.getAddress(
        deposit.token.contract ??
          (() => {
            throw new Error(
              `LayerSwap did not return a contract address for ${args.token} on ARBITRUM_MAINNET`
            )
          })()
      )
  const amount = ethers.utils.parseUnits(
    amountHuman,
    isNative ? 18 : deposit.token.decimals
  )

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'layerSwap',
    integrator: 'ACME Devs',
    referrer: ethers.constants.AddressZero,
    sendingAssetId,
    receiver: isSolana ? NON_EVM_ADDRESS : receiver,
    minAmount: amount,
    destinationChainId,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const layerSwapData: LayerSwapFacet.LayerSwapDataStruct = {
    requestId,
    depositoryReceiver,
    nonEVMReceiver: isSolana
      ? solanaAddressToBytes32(receiver)
      : ethers.constants.HashZero,
  }

  // 3. Approve (ERC20 only) and bridge
  if (!isNative) {
    console.info('\nApproving token...')
    const token = ERC20__factory.connect(sendingAssetId, provider)
    const approveTx = await token
      .connect(signer)
      .approve(diamondAddress, amount)
    await approveTx.wait()
    console.info('✅ Token approved')
  }

  console.info(`\nBridging ${args.token} via LayerSwap...`)
  const tx = await layerSwap
    .connect(signer)
    .startBridgeTokensViaLayerSwap(
      bridgeData,
      layerSwapData,
      isNative ? { value: amount } : {}
    )
  await tx.wait()
  console.info('✅ Bridge transaction confirmed')
  console.info(`Transaction hash: ${tx.hash}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Demo failed')
    console.error(error)
    process.exit(1)
  })
