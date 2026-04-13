import { config } from 'dotenv'
import { ethers, utils } from 'ethers'

import deployments from '../../deployments/arbitrum.staging.json'
import {
  ERC20__factory,
  LayerSwapFacet__factory,
  type ILiFi,
  type LayerSwapFacet,
} from '../../typechain'

import { ADDRESS_USDC_ARB } from './utils/demoScriptHelpers'

config()

// LayerSwap integration docs: https://docs.layerswap.io/lifi-integration
//
// Flow:
//   1. POST /api/v2/swaps with use_depository=true to register a swap.
//   2. Response contains deposit_actions[0] with:
//        - to_address        : the LayerSwap depository contract (must match
//                              LAYERSWAP_DEPOSITORY configured in the facet)
//        - encoded_args[0]   : swap id as bytes32 -> requestId
//        - encoded_args[1]   : whitelisted receiver -> depositoryReceiver
//   3. Call startBridgeTokensViaLayerSwap on the diamond; the facet forwards
//      funds to the depository, which forwards them to the receiver.
//      LayerSwap correlates the deposit off-chain via requestId and completes
//      the bridge on the destination chain.

const LAYERSWAP_API = 'https://api.layerswap.io/api/v2/swaps'

interface LayerSwapNetwork {
  name: string
  chain_id: string
  type: string
}

interface LayerSwapDepositAction {
  order: number
  type: string
  to_address: string
  amount: number
  amount_in_base_units: string
  network: LayerSwapNetwork
  token: { symbol: string; decimals: number; contract: string | null }
  call_data: string
  gas_limit: string
  encoded_args: string[]
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

  if (deposit.encoded_args.length < 2)
    throw new Error(
      `LayerSwap deposit_actions[0].encoded_args has ${deposit.encoded_args.length} entries (expected at least 2)`
    )

  return deposit
}

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_ARBITRUM
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  const LIFI_ADDRESS = deployments.LiFiDiamond

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY as string, provider)
  const layerSwap = LayerSwapFacet__factory.connect(LIFI_ADDRESS, provider)

  const address = await signer.getAddress()

  console.info('=== LayerSwapFacet Demo ===')
  console.info('Sending from this wallet:', address)

  // Demo 1: Bridge native ETH from Arbitrum -> Ethereum mainnet via LayerSwap
  console.info('\n--- Demo 1: Bridge Native ETH (ARB -> ETH) ---')

  const ethAmountHuman = 0.0001
  const ethAmount = ethers.utils.parseEther(ethAmountHuman.toString())

  const ethDeposit = await createLayerSwapSwap({
    source_network: 'ARBITRUM_MAINNET',
    source_token: 'ETH',
    destination_network: 'ETHEREUM_MAINNET',
    destination_token: 'ETH',
    destination_address: address,
    source_address: address,
    amount: ethAmountHuman,
  })

  const ethRequestId = ethDeposit.encoded_args[0] as string
  const ethDepositoryReceiver = utils.getAddress(
    ethDeposit.encoded_args[1] as string
  )

  console.info('LayerSwap depository:', ethDeposit.to_address)
  console.info('Request ID:          ', ethRequestId)
  console.info('Depository receiver: ', ethDepositoryReceiver)
  console.info(
    'Amount:              ',
    ethers.utils.formatEther(ethAmount),
    'ETH'
  )

  let bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'layerSwap',
    integrator: 'ACME Devs',
    referrer: ethers.constants.AddressZero,
    sendingAssetId: ethers.constants.AddressZero, // native ETH
    receiver: address,
    minAmount: ethAmount,
    destinationChainId: 1, // Ethereum mainnet
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  let layerSwapData: LayerSwapFacet.LayerSwapDataStruct = {
    requestId: ethRequestId,
    depositoryReceiver: ethDepositoryReceiver,
    nonEVMReceiver: ethers.constants.HashZero,
  }

  try {
    console.info('Bridging native ETH via LayerSwap...')
    let tx = await layerSwap
      .connect(signer)
      .startBridgeTokensViaLayerSwap(bridgeData, layerSwapData, {
        value: ethAmount,
      })
    await tx.wait()
    console.info('✅ Native ETH bridged successfully!')
    console.info('Transaction hash:', tx.hash)
  } catch (error) {
    console.error(
      '❌ Native ETH bridge failed:',
      error instanceof Error ? error.message : String(error)
    )
  }

  // Demo 2: Bridge USDC from Arbitrum -> Ethereum mainnet via LayerSwap
  console.info('\n--- Demo 2: Bridge USDC (ARB -> ETH) ---')

  const usdcAmountHuman = 1 // 1 USDC
  const usdcAmount = ethers.utils.parseUnits(usdcAmountHuman.toString(), 6)
  const usdc = ERC20__factory.connect(ADDRESS_USDC_ARB, provider)

  const usdcDeposit = await createLayerSwapSwap({
    source_network: 'ARBITRUM_MAINNET',
    source_token: 'USDC',
    destination_network: 'ETHEREUM_MAINNET',
    destination_token: 'USDC',
    destination_address: address,
    source_address: address,
    amount: usdcAmountHuman,
  })

  const usdcRequestId = usdcDeposit.encoded_args[0] as string
  const usdcDepositoryReceiver = utils.getAddress(
    usdcDeposit.encoded_args[1] as string
  )

  console.info('LayerSwap depository:', usdcDeposit.to_address)
  console.info('Request ID:          ', usdcRequestId)
  console.info('Depository receiver: ', usdcDepositoryReceiver)
  console.info(
    'Amount:              ',
    ethers.utils.formatUnits(usdcAmount, 6),
    'USDC'
  )

  bridgeData = {
    transactionId: utils.randomBytes(32),
    bridge: 'layerSwap',
    integrator: 'ACME Devs',
    referrer: ethers.constants.AddressZero,
    sendingAssetId: ADDRESS_USDC_ARB,
    receiver: address,
    minAmount: usdcAmount,
    destinationChainId: 1,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  layerSwapData = {
    requestId: usdcRequestId,
    depositoryReceiver: usdcDepositoryReceiver,
    nonEVMReceiver: ethers.constants.HashZero,
  }

  try {
    console.info('Approving USDC...')
    let tx = await usdc.connect(signer).approve(LIFI_ADDRESS, usdcAmount)
    await tx.wait()
    console.info('✅ USDC approved')

    console.info('Bridging USDC via LayerSwap...')
    tx = await layerSwap
      .connect(signer)
      .startBridgeTokensViaLayerSwap(bridgeData, layerSwapData)
    await tx.wait()
    console.info('✅ USDC bridged successfully!')
    console.info('Transaction hash:', tx.hash)
  } catch (error) {
    console.error(
      '❌ USDC bridge failed:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

main()
  .then(() => {
    console.log('\n✅ Success - All demos completed')
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n❌ Error occurred during demo')
    console.error(error)
    process.exit(1)
  })
