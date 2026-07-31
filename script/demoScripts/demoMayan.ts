import {
  type ChainName,
  type Quote,
  fetchQuote,
  getSwapFromEvmTxPayload,
} from '@mayanfinance/swap-sdk'
import { config } from 'dotenv'
import { BigNumber, constants, ethers, utils } from 'ethers'

import deployments from '../../deployments/arbitrum.staging.json'
import {
  ERC20__factory,
  IMayan__factory,
  MayanFacet__factory,
  type ILiFi,
  type MayanFacet,
} from '../../typechain'

config()

// -----------------------------------------------------------------------------
// Verified staging transaction
//   Diamond   : LiFiDiamond 0xD3b2b0aC0AFdd0d166a495f5E9fca4eCc715a782 (Arbitrum staging)
//   Facet     : MayanFacet v2.0.0 @ 0x9923249c1f14E4BB68F71C689C3fCC323E5410aC
//
//   native ETH -> swapAndForwardEth (EXSC-364):
//     Path   : Arbitrum native ETH --(source swap ETH->USDT via swapProtocol)-->
//              Mayan Swift v2 order --> Polygon USDT (USD₮0)
//     In/Out : 0.001 ETH -> ~1.8388 USDT delivered to the receiver on Polygon
//     Source : 0xa67bb19b7fbf19d4e866b3dd743114ef1b7918533b08576a249a2f58ffdd1f6c
//     Mayan  : ORDER_SETTLED (SWIFT_V2_0x7181b47039e490df07f28628c058f961c29143b47e69fdbd3052ad999d36c363)
//     Note   : the source-side middleToken is USDT here, not WETH — Mayan picks the
//              Swift order's input token per route, so it is quote-dependent.
//
//   ERC20/WETH -> forwardERC20 : <not run — legacy path, unchanged by this PR>
// -----------------------------------------------------------------------------

const ARBITRUM_CHAIN_ID = 42161
const LIFI_ADDRESS = deployments.LiFiDiamond
// Optional Mayan API key (raises rate limits on the swap-router calldata lookup).
const MAYAN_API_KEY = process.env.MAYAN_API_KEY
// Mayan (and the facet's `LibAsset.isNativeAsset`) represents native ETH as the zero address.
const NATIVE_ETH = constants.AddressZero
const ARB_WETH_ADDRESS = '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'
const POLYGON_USDT_ADDRESS = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F'
const EMPTY_NON_EVM_RECEIVER = utils.hexZeroPad('0x', 32)

// Small staging amounts.
const NATIVE_AMOUNT_ETH = 0.001
const WETH_AMOUNT = 0.0014012345678

// Candidate native-ETH destination routes. We pick the first quote whose forwarder
// method is `swapAndForwardEth` — i.e. Mayan routes native ETH through a source
// swap (ETH -> middleToken) before creating the Swift order, which is exactly the
// branch EXSC-364 adds to the facet. Only SWIFT quotes take this path.
const NATIVE_ROUTES: {
  toChain: ChainName
  toToken: string
  destinationChainId: number
}[] = [
  {
    toChain: 'polygon',
    toToken: POLYGON_USDT_ADDRESS,
    destinationChainId: 137,
  },
  {
    toChain: 'base',
    toToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
    destinationChainId: 8453,
  },
  {
    toChain: 'optimism',
    toToken: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', // USDC
    destinationChainId: 10,
  },
]

const iface = IMayan__factory.createInterface()

// Finds a native-ETH quote that Mayan routes through `swapAndForwardEth`, trying the
// candidate routes in order. Returns the parsed forwarder calldata so the caller can
// feed the real swap fields into the facet.
const findNativeSwapAndForwardEthQuote = async (
  address: string,
  route: (typeof NATIVE_ROUTES)[number]
) => {
  const quotes: Quote[] = await fetchQuote({
    amount: NATIVE_AMOUNT_ETH,
    fromToken: NATIVE_ETH,
    fromChain: 'arbitrum',
    toToken: route.toToken,
    toChain: route.toChain,
    slippageBps: 300,
  })

  for (const quote of quotes) {
    if (quote.type !== 'SWIFT') continue

    let payload
    try {
      // In the current SDK this is async: it fetches the source-swap (ETH->middleToken)
      // router calldata from Mayan, which becomes the facet's swapData/swapProtocol.
      payload = await getSwapFromEvmTxPayload(
        quote,
        address,
        address, // destinationAddress == receiver (must match `_parseReceiver`)
        null,
        address,
        ARBITRUM_CHAIN_ID,
        null,
        null,
        { apiKey: MAYAN_API_KEY }
      )
    } catch (err) {
      // Surface auth/network/payload failures instead of silently folding them
      // into the generic "no quote" path, then move to the next candidate.
      console.warn(
        `[${route.toChain}] getSwapFromEvmTxPayload failed for a SWIFT quote:`,
        err instanceof Error ? err.message : err
      )
      continue
    }

    if (payload._forwarder?.method === 'swapAndForwardEth')
      return { quote, payload }
  }

  return undefined
}

// Bridges native ETH via the new `swapAndForwardEth` branch, feeding the facet the
// real swapProtocol / swapData / middleToken / minMiddleAmount produced by Mayan.
const runNativeSwapAndForwardEth = async (
  signer: ethers.Wallet,
  provider: ethers.providers.JsonRpcProvider
) => {
  const address = await signer.getAddress()
  const mayan = MayanFacet__factory.connect(LIFI_ADDRESS, provider)

  let selected: Awaited<ReturnType<typeof findNativeSwapAndForwardEthQuote>>
  let usedRoute: (typeof NATIVE_ROUTES)[number] | undefined
  for (const route of NATIVE_ROUTES) {
    selected = await findNativeSwapAndForwardEthQuote(address, route)
    if (selected) {
      usedRoute = route
      break
    }
  }

  if (!selected || !usedRoute) {
    throw new Error(
      'No native-ETH SWIFT quote routed through swapAndForwardEth for any candidate route. ' +
        'Mayan may currently accept native ETH directly (forwardEth) for these routes — ' +
        'try a different toChain/toToken or amount.'
    )
  }

  const { quote, payload } = selected
  const parsed = iface.parseTransaction({ data: payload.data as string })
  if (parsed.name !== 'swapAndForwardEth') {
    throw new Error(`Unexpected forwarder method parsed: ${parsed.name}`)
  }

  const amountIn = BigNumber.from(parsed.args.amountIn)

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'Mayan',
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: NATIVE_ETH,
    receiver: address,
    minAmount: amountIn,
    destinationChainId: usedRoute.destinationChainId,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const mayanData: MayanFacet.MayanDataStruct = {
    nonEVMReceiver: EMPTY_NON_EVM_RECEIVER,
    mayanProtocol: parsed.args.mayanProtocol,
    // NB: on swapAndForwardEth the inner Mayan order calldata is the `mayanData` arg
    // (not `protocolData`, which is the forwardEth/forwardERC20 arg name).
    protocolData: parsed.args.mayanData,
    swapProtocol: parsed.args.swapProtocol,
    swapData: parsed.args.swapData,
    middleToken: parsed.args.middleToken,
    minMiddleAmount: parsed.args.minMiddleAmount,
    refundRecipient: address,
    mayanAmountIn: amountIn,
  }

  console.info('Dev Wallet Address:', address)
  console.info(
    `Route: Arbitrum native ETH -> ${usedRoute.toChain} (${quote.type})`
  )
  console.info('Forwarder method:', parsed.name)
  console.info('swapProtocol:', mayanData.swapProtocol)
  console.info('middleToken:', mayanData.middleToken)
  console.info('minMiddleAmount:', mayanData.minMiddleAmount.toString())
  console.info(
    `Bridging ${utils.formatEther(
      amountIn
    )} native ETH via swapAndForwardEth...`
  )

  const gasPrice = await provider.getGasPrice()
  const tx = await mayan
    .connect(signer)
    .startBridgeTokensViaMayan(bridgeData, mayanData, {
      value: amountIn,
      gasPrice,
    })
  console.info('Tx submitted:', tx.hash)
  console.info(`Arbiscan: https://arbiscan.io/tx/${tx.hash}`)
  const receipt = await tx.wait()
  console.info(
    `Bridged native ETH. status=${receipt.status} hash=${receipt.transactionHash}`
  )
}

// Legacy ERC20 path: bridges WETH via `forwardERC20` (no source swap). Kept for
// regression coverage of the unchanged ERC20 branch.
const runErc20ForwardErc20 = async (
  signer: ethers.Wallet,
  provider: ethers.providers.JsonRpcProvider
) => {
  const address = await signer.getAddress()
  const mayan = MayanFacet__factory.connect(LIFI_ADDRESS, provider)

  const quotes: Quote[] = await fetchQuote({
    amount: WETH_AMOUNT,
    fromToken: ARB_WETH_ADDRESS,
    toToken: POLYGON_USDT_ADDRESS,
    fromChain: 'arbitrum',
    toChain: 'polygon',
    slippageBps: 300,
  })

  if (!quotes[0]) {
    throw new Error('No Mayan quote returned')
  }

  const payload = await getSwapFromEvmTxPayload(
    quotes[0],
    address,
    address,
    null,
    address,
    ARBITRUM_CHAIN_ID,
    null,
    null,
    { apiKey: MAYAN_API_KEY }
  )

  const parsed = iface.parseTransaction({ data: payload.data as string })
  if (parsed.name !== 'forwardERC20') {
    throw new Error(
      `Expected forwardERC20 for the WETH path but Mayan returned ${parsed.name}`
    )
  }
  // Derive the exact amount Mayan expects instead of hard-coding it.
  const amountIn = BigNumber.from(parsed.args.amountIn)

  const token = ERC20__factory.connect(ARB_WETH_ADDRESS, provider)

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId: utils.randomBytes(32),
    bridge: 'Mayan',
    integrator: 'ACME Devs',
    referrer: constants.AddressZero,
    sendingAssetId: ARB_WETH_ADDRESS,
    receiver: address,
    minAmount: amountIn,
    destinationChainId: 137,
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const mayanData: MayanFacet.MayanDataStruct = {
    nonEVMReceiver: EMPTY_NON_EVM_RECEIVER,
    mayanProtocol: parsed.args.mayanProtocol,
    protocolData: parsed.args.protocolData,
    // Native-swap fields (swapAndForwardEth); unused on this ERC20 path.
    swapProtocol: NATIVE_ETH,
    swapData: '0x',
    middleToken: NATIVE_ETH,
    minMiddleAmount: 0,
    refundRecipient: address,
    mayanAmountIn: amountIn,
  }

  console.info('Dev Wallet Address:', address)
  const gasPrice = await provider.getGasPrice()
  console.info('Approving WETH...')
  let tx = await token
    .connect(signer)
    .approve(LIFI_ADDRESS, constants.MaxUint256, { gasPrice })
  await tx.wait()
  console.info('Approved WETH')
  console.info(
    `Bridging ${utils.formatEther(amountIn)} WETH via forwardERC20...`
  )
  tx = await mayan
    .connect(signer)
    .startBridgeTokensViaMayan(bridgeData, mayanData, { gasPrice })
  console.info('Tx submitted:', tx.hash)
  console.info(`Arbiscan: https://arbiscan.io/tx/${tx.hash}`)
  const receipt = await tx.wait()
  console.info(
    `Bridged WETH. status=${receipt.status} hash=${receipt.transactionHash}`
  )
}

const main = async () => {
  const RPC_URL = process.env.ETH_NODE_URI_ARBITRUM
  const PRIVATE_KEY = process.env.PRIVATE_KEY
  if (!RPC_URL) throw new Error('ETH_NODE_URI_ARBITRUM is not set')
  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY is not set')

  // MAYAN_DEMO_MODE=native (default) exercises the new swapAndForwardEth branch;
  // MAYAN_DEMO_MODE=erc20 exercises the legacy forwardERC20 branch. Reject anything
  // else rather than silently defaulting to native — this script broadcasts a real tx.
  const mode = (process.env.MAYAN_DEMO_MODE ?? 'native').toLowerCase()
  if (mode !== 'native' && mode !== 'erc20') {
    throw new Error(
      `Unsupported MAYAN_DEMO_MODE="${mode}" (expected "native" or "erc20")`
    )
  }

  const provider = new ethers.providers.JsonRpcProvider(RPC_URL)
  const signer = new ethers.Wallet(PRIVATE_KEY, provider)

  if (mode === 'erc20') {
    await runErc20ForwardErc20(signer, provider)
  } else {
    await runNativeSwapAndForwardEth(signer, provider)
  }
}

main()
  .then(() => {
    console.log('Success')
    process.exit(0)
  })
  .catch((error) => {
    console.error('error')
    console.error(error)
    process.exit(1)
  })
