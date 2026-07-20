/**
 * Demo: FraxFacet against the LI.FI staging Diamond (EXSC-382).
 *
 * Fetches a bridge quote from the public Frax LayerZero-route API, maps the
 * response into LI.FI BridgeData + FraxData, and calls
 * FraxFacet.startBridgeTokensViaFrax on the arbitrum staging Diamond. It
 * demonstrates the two hub-and-spoke shapes from arbitrum (a spoke):
 *   1. arbitrum -> fraxtal  (1 hop, direct to the Fraxtal hub, dstEid 30255)
 *   2. arbitrum -> base     (2 hops, composed via Fraxtal, dstEid 30184)
 *
 * The whole point of the demo is to show, explicitly, how the Frax API response
 * maps onto the facet calldata (approvalAddress -> the HopV2 target;
 * transactionRequest.value -> FraxData.nativeFee; meta.sendOftCall.args ->
 * FraxData.oft/dstEid).
 *
 * PREREQUISITES (this will only succeed once these hold — it is meant to be run
 * AFTER the staging deployment, not against mainnet before funds exist):
 *   - FraxFacet deployed and registered on the arbitrum staging Diamond, with the
 *     chainId -> LayerZero EID mapping seeded for the destination chain (initFrax /
 *     setChainIdToEid) — otherwise the facet reverts UnsupportedChainId
 *   - the staging dev wallet funded with frxUSD (the bridged amount) and a little
 *     ETH to cover the native LayerZero messaging fee
 *
 * NOTE: Tempo-as-source is intentionally NOT demoed here. On Tempo the LayerZero
 * fee is paid in a TIP20 ERC20 gas token (not native msg.value) and the flow is
 * different (the Diamond must hold/approve the fee token) — see docs/FraxFacet.md
 * ("Tempo (EndpointV2Alt) special case").
 *
 * Run:  bunx tsx script/demoScripts/demoFrax.ts --route arbitrum-fraxtal
 *       bunx tsx script/demoScripts/demoFrax.ts --route both
 */
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import {
  erc20Abi,
  getAddress,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from 'viem'

import type { SupportedChain } from '../common/types'
import { EnvironmentEnum } from '../common/types'
import { fetchWithTimeout } from '../utils/fetchWithTimeout'

import {
  createContractObject,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

// Read the Forge artifact at runtime rather than statically importing it: the
// validate-scripts CI job runs without a prior `forge build`, so a static
// `import ... from '../../out/...json'` fails TS2307 there even though a full
// local `forge build` produces the file.
interface IForgeArtifact {
  abi: Abi
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function readIForgeArtifact(
  contractFile: string,
  contractName: string
): IForgeArtifact {
  const artifactPath = path.join(
    __dirname,
    '../../out',
    contractFile,
    `${contractName}.json`
  )
  return JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as IForgeArtifact
}

const FRAX_FACET_ABI = readIForgeArtifact('FraxFacet.sol', 'FraxFacet').abi

// Public Frax LayerZero-route API (no auth). It already bakes a ~10% buffer into
// transactionRequest.value; HopV2 refunds the overage to the refundRecipient.
const FRAX_API_BASE = 'https://lz-route-api.ext.frax.com'

// frxUSD is a self-OFT on arbitrum: the OFT messenger address IS the ERC20 token
// (18 decimals, decimalConversionRate 1e12). See docs/FraxFacet.md.
const FRXUSD_ARBITRUM: Address = getAddress(
  '0x80Eede496655FB9047dd39d9f418d5483ED600df'
)

// The HopV2 contract (== the quote's approvalAddress / transactionRequest.to)
// shares one CREATE2 address across all spokes. This demo always bridges FROM
// arbitrum (a spoke), so the source-chain Hop is always this spoke address for
// both routes — the destination (hub or another spoke) does not change it. Used
// here only to sanity-check the API response, never sent as calldata (the facet
// targets its own immutable HOP). The Fraxtal hub 0x00000000e18a…B36 is only the
// source Hop when bridging FROM Fraxtal, which this demo does not do.
const FRAX_HOP_SPOKE: Address = getAddress(
  '0x0000006D38568b00B457580b734e0076C62de659'
)

// 5 frxUSD (18 decimals) — small demo amount; keep it well under the staging dev
// wallet's frxUSD balance (a clean 1e12-dust-rate multiple, so no dust remainder).
const DEMO_AMOUNT = parseUnits('5', 18)

interface IFraxRoute {
  /** Network key for setupEnvironment / deployments lookup (source chain). */
  srcChain: SupportedChain
  /** Chain name the Frax API expects in the fromChain/toChain query params. */
  apiFromChain: string
  apiToChain: string
  /** LayerZero endpoint ID of the destination chain (goes into FraxData.dstEid). */
  dstEid: number
  /** Analytics-only destination chainId for BridgeData.destinationChainId. */
  destinationChainId: number
}

// LayerZero EIDs: fraxtal 30255, base 30184, arbitrum 30110.
const ROUTES: Record<string, IFraxRoute> = {
  'arbitrum-fraxtal': {
    srcChain: 'arbitrum',
    apiFromChain: 'arbitrum',
    apiToChain: 'fraxtal',
    dstEid: 30255,
    destinationChainId: 252,
  },
  'arbitrum-base': {
    srcChain: 'arbitrum',
    apiFromChain: 'arbitrum',
    apiToChain: 'base',
    dstEid: 30184,
    destinationChainId: 8453,
  },
}

// Shape of the fields this demo consumes from the Frax /lifi/quote response.
// approvalAddress is the HopV2 token-approval target; transactionRequest.value is
// the native LZ fee (with the API's built-in buffer); meta.sendOftCall.args holds
// the decoded sendOFT parameters.
interface IFraxQuoteResponse {
  approvalAddress: string
  transactionRequest: {
    to: string
    value: string
    data: string
  }
  meta: {
    sendOftCall: {
      args: {
        oft: string
        dstEid: number
        recipient: string
        amountLd: string
        dstGas: string | number
        data: string
      }
    }
  }
  feeCosts?: { amount: string }[]
}

/**
 * Fetches a frxUSD->frxUSD bridge quote from the public Frax LayerZero-route API.
 *
 * @param route - The demo route (source/destination + API chain names)
 * @param amount - Amount to bridge, in frxUSD wei (18 decimals)
 * @param address - Sender and receiver address (the staging dev wallet)
 * @returns The parsed quote response
 * @throws If the API returns a non-2xx status or a response missing the fields the demo maps into calldata
 */
async function getFraxQuote(
  route: IFraxRoute,
  amount: bigint,
  address: Address
): Promise<IFraxQuoteResponse> {
  const url =
    `${FRAX_API_BASE}/lifi/quote?fromChain=${route.apiFromChain}` +
    `&toChain=${route.apiToChain}&fromToken=frxUSD&toToken=frxUSD` +
    `&fromAmount=${amount.toString()}&fromAddress=${address}&toAddress=${address}`

  consola.info(`Fetching Frax quote: ${url}`)
  const response = await fetchWithTimeout(url)
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(
      `Frax quote request failed: ${response.status} - ${errorText}`
    )
  }

  const data = (await response.json()) as IFraxQuoteResponse
  if (
    !data?.transactionRequest?.value ||
    !data?.meta?.sendOftCall?.args?.oft ||
    !data?.meta?.sendOftCall?.args?.dstEid
  )
    throw new Error(
      `Unexpected Frax quote response (missing transactionRequest.value or meta.sendOftCall.args): ${JSON.stringify(
        data
      )}`
    )

  return data
}

async function bridgeViaFrax(routeKey: string): Promise<void> {
  const route = ROUTES[routeKey]
  if (!route)
    throw new Error(
      `Unknown route '${routeKey}'. Valid routes: ${Object.keys(ROUTES).join(
        ', '
      )}`
    )

  // === Set up environment (arbitrum staging Diamond, staging dev wallet) ===
  const { publicClient, walletClient, walletAccount, lifiDiamondAddress } =
    await setupEnvironment(
      route.srcChain,
      FRAX_FACET_ABI,
      EnvironmentEnum.staging
    )

  if (!lifiDiamondAddress)
    throw new Error(
      `LiFiDiamond not found for ${route.srcChain} (staging). Is FraxFacet deployed there yet?`
    )

  const devWallet = walletAccount.address
  const amount = DEMO_AMOUNT

  consola.info(
    `Bridge ${amount} frxUSD from ${route.apiFromChain} --> ${route.apiToChain} via Frax`
  )
  consola.info(`Connected wallet (staging dev wallet): ${devWallet}`)
  consola.info(`LiFiDiamond (staging): ${lifiDiamondAddress}`)

  // === Fetch quote and map the response onto facet calldata ===
  const quote = await getFraxQuote(route, amount, devWallet)

  const nativeFee = BigInt(quote.transactionRequest.value)
  const oft = getAddress(quote.meta.sendOftCall.args.oft)
  const dstEid = quote.meta.sendOftCall.args.dstEid
  // arbitrum is the source (a spoke) for both routes, so the source-chain Hop —
  // and thus approvalAddress / transactionRequest.to — is always the spoke address.
  const expectedHop = FRAX_HOP_SPOKE

  consola.box('Frax API response -> facet calldata mapping')
  consola.info(`  approvalAddress (HopV2 target): ${quote.approvalAddress}`)
  consola.info(
    `  transactionRequest.to:          ${quote.transactionRequest.to}`
  )
  consola.info(
    `  transactionRequest.value:       ${nativeFee} wei -> FraxData.nativeFee`
  )
  consola.info(`  sendOftCall.args.oft:           ${oft} -> FraxData.oft`)
  consola.info(`  sendOftCall.args.dstEid:        ${dstEid} -> FraxData.dstEid`)
  consola.info(
    `  sendOftCall.args.recipient:     ${quote.meta.sendOftCall.args.recipient}`
  )
  consola.info(
    `  sendOftCall.args.amountLd:      ${quote.meta.sendOftCall.args.amountLd}`
  )
  if (quote.feeCosts?.length)
    consola.info(
      `  feeCosts[0].amount:             ${quote.feeCosts[0]?.amount}`
    )

  // The API controls oft/dstEid/recipient/amount and the Hop target, so validate
  // them against what we requested and ABORT on any mismatch — an unexpected dstEid
  // or Hop could otherwise strand funds. (In production the LI.FI backend enforces
  // this; here we fail loudly rather than send against a surprising quote.)
  // recipient is a bytes32 (address left-padded) — compare its trailing 20 bytes
  const recipientAddr = getAddress(
    `0x${quote.meta.sendOftCall.args.recipient.slice(-40)}`
  )
  if (
    oft !== FRXUSD_ARBITRUM ||
    dstEid !== route.dstEid ||
    recipientAddr !== devWallet ||
    BigInt(quote.meta.sendOftCall.args.amountLd) !== amount ||
    getAddress(quote.approvalAddress) !== expectedHop ||
    getAddress(quote.transactionRequest.to) !== expectedHop
  )
    throw new Error(
      `Frax quote routing does not match the requested ${route.apiFromChain}->${route.apiToChain} route`
    )

  // === Ensure balance + allowance (the Diamond pulls frxUSD via depositAsset) ===
  const token = createContractObject(
    FRXUSD_ARBITRUM,
    erc20Abi as Abi,
    publicClient,
    walletClient
  )
  await ensureBalance(token, devWallet, amount, publicClient)
  await ensureAllowance(
    token,
    devWallet,
    lifiDiamondAddress,
    amount,
    publicClient
  )

  // === Build BridgeData + FraxData ===
  const bridgeData = {
    transactionId: `0x${randomBytes(32).toString('hex')}` as Hex,
    bridge: 'frax',
    integrator: 'lifi-demo',
    referrer: zeroAddress,
    sendingAssetId: FRXUSD_ARBITRUM,
    receiver: devWallet,
    minAmount: amount,
    destinationChainId: BigInt(route.destinationChainId),
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  const fraxData = {
    oft,
    dstEid,
    nativeFee,
    refundRecipient: devWallet,
  }

  consola.info('BridgeData:', bridgeData)
  consola.info('FraxData:', fraxData)

  // === Start bridging (native fee forwarded as msg.value) ===
  const txHash = await executeTransaction(
    () =>
      walletClient.writeContract({
        address: lifiDiamondAddress,
        abi: FRAX_FACET_ABI,
        functionName: 'startBridgeTokensViaFrax',
        args: [bridgeData, fraxData],
        value: nativeFee,
      }),
    `Bridge frxUSD ${route.apiFromChain}->${route.apiToChain} via Frax`,
    publicClient,
    true
  )

  if (txHash) {
    consola.success(`Bridge tx: ${txHash}`)
    consola.info(
      `Track LayerZero delivery: https://layerzeroscan.com/tx/${txHash}`
    )
    consola.info(
      `Check Frax bridge status: GET ${FRAX_API_BASE}/lifi/transaction/${txHash}`
    )
  }
}

const command = defineCommand({
  meta: {
    name: 'demoFrax',
    description: 'Demo bridging frxUSD from arbitrum via FraxFacet (staging)',
  },
  args: {
    route: {
      type: 'string',
      default: 'arbitrum-fraxtal',
      description:
        "Route to demo: 'arbitrum-fraxtal', 'arbitrum-base', or 'both'",
    },
  },
  async run({ args }) {
    const routeKeys =
      args.route === 'both' ? Object.keys(ROUTES) : [args.route as string]
    for (const routeKey of routeKeys) await bridgeViaFrax(routeKey)
  },
})

runMain(command)
