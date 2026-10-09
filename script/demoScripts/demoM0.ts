/**
 * Demo for the M0Facet. Select a scenario with `--scenario <name>`:
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-samechain
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-to-citrea
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-to-citrea-w-swap
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-to-rise
 *   bunx tsx script/demoScripts/demoM0.ts --scenario arbitrum-to-rise
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-to-solana
 *
 * Executed runs (staging diamond, mainnet):
 *   mainnet-samechain       OPEN https://etherscan.io/tx/0x23d9328cc72a4a35a3a7309a1f046be147404e83209ca808111d4871d3f91be8
 *                           FILL https://etherscan.io/tx/0xf7afafb6ac5304a370b4055ff9bc739179d2b0cc66b0156fb45e08b3b2373b6b
 *                           order 0xf84df03882ed233400682549f7607ccddd293aba8c2b98365fdef152ca1cbc5d
 *                           4 USDC -> 1 wM, filled by Farsight Solver two blocks (~24s) after
 *                           open. The 3 USDC spread is the solver's flat fee, not slippage.
 *   mainnet-to-citrea       OPEN https://etherscan.io/tx/0xefe1ea1c2f99c446e564ca2e79e04ed97a5c8f455983aac5c7b96f9770a43627
 *                           FILL (Citrea) 0x87aefb99bf00eeb355a3561899223bdf77361bce0441f8e8263e01c5790906bf
 *                           order 0xa5526251bbeb04fb2ad351296479e57c7cf8e2420aaccae05864890348af747b
 *                           1 USDC -> 1 ctUSD, filled 18s after open at feeBps 0; amountIn,
 *                           amountOut, amountOutFilled and amountInReleased all 1000000.
 *   mainnet-to-citrea-w-swap OPEN https://etherscan.io/tx/0xba41e70776291e268c05dcec2d59b34e606b0640527197e888cbec1c3950d2ab
 *                           FILL (Citrea) 0xe13ab036471bc3250d86d498b909088d5869766b52207f4f6ad49ae42d9f47f5
 *                           order 0x745eb8aac8ce457bde753fed0fa9fe4396d75d4ae9a15c52f03f0e9e86857f72
 *                           2 USDT pre-swapped to USDC, then bridged to ctUSD. The run that
 *                           covers swapAndStartBridgeTokensViaM0 and the amountOut scaling:
 *                             declared floor (bridgeData.minAmount) 1_931_234  <- 3% under
 *                             amountOut quoted against that floor   1_931_234
 *                             realized swap output                  1_990_963
 *                             amountOut actually escrowed           1_990_963  <- scaled
 *                           Unscaled, the ~59_729 units of positive slippage would have gone
 *                           to the solver as a better rate. It went to the user.
 *   mainnet-to-solana       OPEN https://etherscan.io/tx/0x5d5450c588df2e2750482420f5f41c0cc663b5f8adb3c3c61a87c8d439183bed
 *                           FILL (Solana) 4hZpFDt7nNQjMWKAKKnPEh9ARwkCKZfdvpdtZhJjV8uhYHWaSZGqAx2936ND2Gv39drYFreHTA7cmhReTSAsw8xn
 *                           order 0x212b1ccc8c433c657f9b7406efa387d0e10eedf1fa825621d54a216075bfabc4
 *                           1 USDC -> 1 XO, filled by M0 Solver 23s after open at feeBps 0.
 *                           The only run covering the non-EVM path: BridgeToNonEVMChainBytes32
 *                           carries LIFI_CHAIN_ID_SOLANA and the decoded CT55XSqd... pubkey
 *                           while LiFiTransferStarted carries the NON_EVM_ADDRESS sentinel,
 *                           OrderOpened shows destChainId 1399811149, and the fill came back
 *                           from CLBFpZhM6gvqrEBSPygeuW5KyetWzsXYbDUNqYz9zoTu — the round trip
 *                           that proves the encoding in `solverToBytes32`.
 *
 * mainnet-to-rise and arbitrum-to-rise have not been run. Cancellation of a CROSS-CHAIN order
 * is also unexercised — every cross-chain order above filled, so the destination-chain cancel
 * with msg.value for the Portal message is untested. The only cancellation that has run is the
 * same-chain counter-example to the designated-solver rule below: same route and price as
 * mainnet-samechain but opened with bytes32(0), never filled, cancelled after fillDeadline for
 * a full refund (order 0x719c928678c9073f20339342f1adb290a00f85f2f14cd9c48f53000aac50a239).
 *
 * The M0 OrderBook escrows the sending asset and returns — a solver settles the order
 * later on the destination chain. A successful run therefore only proves the order was
 * OPENED; the fill, or the cancellation once `fillDeadline` passes, happens outside this
 * script. See docs/M0Facet.md.
 *
 * `amountOut` is a limit price, not a slippage floor. It comes from M0's Orchestration API
 * (`POST /quote`, provider `limit-order`), which needs `M0_API_KEY` in `.env`. On the swap
 * scenarios the facet scales it to the realized swap output, so positive slippage reaches
 * the user rather than the solver.
 *
 * Quotes come back `exclusive: true`: the quoting solver priced the leg for itself and is
 * the only one obliged to fill it, so it has to become the order's `designatedSolver`.
 * Opening with bytes32(0) at an exclusive quote's price leaves an order nobody picks up —
 * it sits at CREATED until `fillDeadline`. `resolveLimitPrice` falls back to an arbitrary
 * limit price only if coverage is withdrawn from a route.
 *
 * COVERAGE is a per-route solver allowlist, not a property of the protocol, so it is worth
 * re-probing rather than inferring. Against `POST /quote` as of 2026-09-25:
 *
 *   - SAME-CHAIN quotes broadly. Live pairs: Ethereum USDC<->USDat, wM->USDC; Arbitrum
 *     CUSD<->USDC and CUSD<->PYUSD; Base mrUSD/AUSD/wM<->USDC.
 *   - CROSS-CHAIN quotes on exactly four pairs, the ones the scenarios below use:
 *     USDC.eth<->ctUSD.citrea, USDC.eth<->USDR.rise, USDC.arb<->USDR.rise and
 *     USDC.eth->XO.sol. Anything else 404s `NoQuotesAvailable`. Coverage is DIRECTIONAL:
 *     the return legs out of Rise price 5e6 below par and 404 below a 1e7 input, and
 *     XO.sol->USDC.eth does not quote at any size.
 *   - SAME-CHAIN pricing is fee = max(3_000_000, 3bps) — flat below 10_000 units,
 *     proportional above. The minimum input is 4e6: 3_999_999 is refused, 4e6 quotes 1e6
 *     out, so the fee must leave at least 1e6. Being flat in that range, a run costs 3
 *     units whether you send 4 or 10_000; size only changes the balance you have to hold.
 *
 * Every cross-chain payload is approve + a single `openOrder` on the same OrderBook the
 * same-chain payload targets, with `feeBps: 0` on the four pairs above, so cross-chain
 * asks nothing of the facet that same-chain does not. `destChainId` is the destination's
 * EVM chain id (Citrea 4114, Rise 4153), except Solana, which is 1399811149 — the facet's
 * `M0_CHAIN_ID_SOLANA`, translated by `_resolveDestination` from LI.FI's 1151111081099710.
 *
 * The swap scenarios need the Uniswap V2 router whitelisted on the diamond. The gate is
 * per contract+selector in WhitelistManagerFacet, not the legacy approvedDexs list, so
 * check it with isContractSelectorWhitelisted; an unset pair (0x7a250d56...F2488D,
 * 0x38ed1739) reverts ContractCallNotAllowed.
 */
import { randomBytes } from 'crypto'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import { BigNumber } from 'ethers'
import {
  getAddress,
  getContract,
  parseUnits,
  slice,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import {
  ERC20__factory,
  IM0OrderBook__factory,
  M0Facet__factory,
} from '../../typechain'
import type { ILiFi, M0Facet } from '../../typechain'
import type { LibSwap } from '../../typechain/M0Facet'
import { EnvironmentEnum, type SupportedChain } from '../common/types'

import {
  ADDRESS_UNISWAP_ETH,
  ADDRESS_USDC_ARB,
  ADDRESS_USDC_ETH,
  ADDRESS_USDT_ETH,
  LIFI_CHAIN_ID_SOLANA,
  NON_EVM_ADDRESS,
  deriveSolanaAddress,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getAmountsOutUniswap,
  getPrivateKeyForEnvironment,
  getUniswapSwapDataERC20ToERC20,
  setupEnvironment,
  solanaAddressToBytes32,
  zeroPadAddressToBytes32,
} from './utils/demoScriptHelpers'

config()

// M0's own chain id for Solana; the facet translates LIFI_CHAIN_ID_SOLANA into it.
const M0_CHAIN_ID_SOLANA = 1399811149

// bytes32(0) leaves the order open to any solver.
const ANY_SOLVER: Hex =
  '0x0000000000000000000000000000000000000000000000000000000000000000'

const FILL_DEADLINE_SECONDS = 3600

// keccak256 of the OrderBook's OrderOpened signature (see logFillStatusCommand).
const ORDER_OPENED_TOPIC: Hex =
  '0xbf2b26246c7c9d256de05b7dbd48ebf43c20cc61ca4a2c684ace2c8b9d4cf23b'

// WrappedM by M0 on Ethereum (6 decimals) — the same-chain scenario's tokenOut.
const ADDRESS_WM_ETH = '0x437cc33344a0B27A429f795ff6B469C72698B291'

// The cross-chain destination tokens M0 currently has solver coverage for. All 6
// decimals, like the USDC that funds every scenario.
const ADDRESS_CTUSD_CITREA = '0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D'
const ADDRESS_USDR_RISE = '0x62b7f5A5Be488ea58f660C5aff465647213Bc6e9'
const ADDRESS_XO_SOL = 'xoUSDq85Rjsb6SbUwJyreFgeWQvxdkT7R3c3g7s6p5Y'

// Neither chain is in config/networks.json — LI.FI does not deploy there. They appear
// only as M0 destinations, which never needs more than the chain id.
const CHAIN_ID_CITREA = 4114n
const CHAIN_ID_RISE = 4153n

// M0's Orchestration API. Needs M0_API_KEY in .env; see the coverage note above.
const M0_API_URL =
  process.env.M0_API_URL || 'https://gateway.m0.xyz/v1/orchestration'

// Every request carries the key in an x-api-key header, so a plain-http override would put
// it on the wire in cleartext. Checked at load, before the key is read at all.
if (new URL(M0_API_URL).protocol !== 'https:') {
  throw new Error(
    `M0_API_URL must use https (got ${M0_API_URL}) — M0_API_KEY is sent as a request header.`
  )
}

type Scenario =
  | 'mainnet-samechain'
  | 'mainnet-to-citrea'
  | 'mainnet-to-citrea-w-swap'
  | 'mainnet-to-rise'
  | 'arbitrum-to-rise'
  | 'mainnet-to-solana'

const SCENARIO_NAMES = [
  'mainnet-samechain',
  'mainnet-to-citrea',
  'mainnet-to-citrea-w-swap',
  'mainnet-to-rise',
  'arbitrum-to-rise',
  'mainnet-to-solana',
] as const

interface IPreSwap {
  fromToken: Address
  fromAmount: bigint // exact-input pre-swap; the floor is derived live with slippageBps
  slippageBps: number // basis points (e.g. 300 = 3%)
  uniswapRouter: Address
}

/// Chain names as M0's Orchestration API spells them, which is not our chain ids.
type M0Chain = 'Ethereum' | 'Base' | 'Arbitrum' | 'Citrea' | 'Rise' | 'Solana'

/// The route as `/quote` wants it: the escrowed token on the source chain, and the
/// destination token in its native text form (hex for EVM, base58 for Solana).
interface IQuoteRoute {
  sourceChain: M0Chain
  destinationChain: M0Chain
  destinationAsset: string
}

/// The solver behind a limit-order leg. `exclusive` means the leg is bound to this
/// solver on-chain, i.e. it must become the order's designatedSolver.
interface IM0PayloadSolver {
  address: string
  name: string | null
  exclusive: boolean
}

interface IM0QuotePayload {
  provider: string
  solver?: IM0PayloadSolver
}

interface IM0QuoteResponse {
  amountOut: string
  payloads: IM0QuotePayload[]
}

/// A quote reduced to what the order actually needs: the limit price and the solver to
/// designate (bytes32(0) when the quote is open-fill).
interface IM0Quote {
  amountOut: bigint
  solver: Hex
  solverName: string | null
}

interface IScenarioConfig {
  description: string
  sourceChain: SupportedChain
  sourceChainId: number
  destinationChainId: bigint // LI.FI chain id (Solana uses LIFI_CHAIN_ID_SOLANA)
  sendingAssetId: Address // the escrowed token, i.e. the post-swap token when preSwap is set
  amount: string // human-readable; ignored when preSwap is set
  tokenOut: Hex // destination token as bytes32
  destinationIsSolana: boolean
  quoteRoute: IQuoteRoute
  /// Only used when M0 cannot quote the route. NOT a market rate — an arbitrary limit
  /// price that lets the demo still open an order, so the facet path stays exercisable
  /// while `limit-order` has no solver coverage. See `resolveLimitPrice`.
  fallbackLimitPriceBps: number
  preSwap?: IPreSwap
}

const SCENARIOS: Record<Scenario, IScenarioConfig> = {
  'mainnet-samechain': {
    description:
      'Ethereum → Ethereum · 4 USDC → WrappedM (same-chain order, asynchronous escrow)',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: 1n, // == source: same-chain order, allowed on purpose
    sendingAssetId: getAddress(ADDRESS_USDC_ETH),
    // The only scenario a solver actually quotes, at exactly the floor: 3_999_999 is
    // refused and 4_000_000 quotes 1_000_000 out, because the fee must leave at least
    // 1e6. Sending more would not cost more — the fee is flat up to 10_000 — so the
    // floor is simply the smallest balance the run needs.
    amount: '4',
    tokenOut: zeroPadAddressToBytes32(ADDRESS_WM_ETH),
    destinationIsSolana: false,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Ethereum',
      destinationAsset: ADDRESS_WM_ETH,
    },
    fallbackLimitPriceBps: 10,
  },

  // The cross-chain scenarios below all run at 1 USDC, which is the floor: 100_000 is
  // refused and 1_000_000 quotes 1_000_000 out. Unlike same-chain, these price at
  // feeBps 0 — amountOut equals amountIn, so the whole spread here is gas, not fee.

  'mainnet-to-citrea': {
    description: 'Ethereum → Citrea · 1 USDC → ctUSD (cross-chain order)',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: CHAIN_ID_CITREA,
    sendingAssetId: getAddress(ADDRESS_USDC_ETH),
    amount: '1',
    tokenOut: zeroPadAddressToBytes32(ADDRESS_CTUSD_CITREA),
    destinationIsSolana: false,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Citrea',
      destinationAsset: ADDRESS_CTUSD_CITREA,
    },
    fallbackLimitPriceBps: 10,
  },

  'mainnet-to-citrea-w-swap': {
    description:
      'Ethereum → Citrea · USDT→USDC pre-swap on Ethereum, then bridge USDC → ctUSD',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: CHAIN_ID_CITREA,
    sendingAssetId: getAddress(ADDRESS_USDC_ETH), // post-swap token
    amount: '1', // ignored: the pre-swap output decides amountIn
    tokenOut: zeroPadAddressToBytes32(ADDRESS_CTUSD_CITREA),
    destinationIsSolana: false,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Citrea',
      destinationAsset: ADDRESS_CTUSD_CITREA,
    },
    fallbackLimitPriceBps: 10,
    preSwap: {
      fromToken: getAddress(ADDRESS_USDT_ETH),
      // 2 USDT, not 1: amountOut is quoted against the declared floor, and at 1 USDT the
      // floor lands under M0's 1e6 minimum and the quote 404s.
      fromAmount: 2_000_000n,
      // Exact-input swap: the realized output exceeds the declared floor by roughly
      // slippageBps, which is what exercises the facet's amountOut scaling.
      slippageBps: 300,
      uniswapRouter: getAddress(ADDRESS_UNISWAP_ETH),
    },
  },

  'mainnet-to-rise': {
    description: 'Ethereum → RISE · 1 USDC → USDR (cross-chain order)',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: CHAIN_ID_RISE,
    sendingAssetId: getAddress(ADDRESS_USDC_ETH),
    amount: '1',
    tokenOut: zeroPadAddressToBytes32(ADDRESS_USDR_RISE),
    destinationIsSolana: false,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Rise',
      destinationAsset: ADDRESS_USDR_RISE,
    },
    fallbackLimitPriceBps: 10,
  },

  'arbitrum-to-rise': {
    description: 'Arbitrum → RISE · 1 USDC → USDR (cross-chain order)',
    sourceChain: 'arbitrum',
    sourceChainId: 42161,
    destinationChainId: CHAIN_ID_RISE,
    sendingAssetId: getAddress(ADDRESS_USDC_ARB),
    amount: '1',
    tokenOut: zeroPadAddressToBytes32(ADDRESS_USDR_RISE),
    destinationIsSolana: false,
    quoteRoute: {
      sourceChain: 'Arbitrum',
      destinationChain: 'Rise',
      destinationAsset: ADDRESS_USDR_RISE,
    },
    fallbackLimitPriceBps: 10,
  },

  'mainnet-to-solana': {
    // XO Cash, not USDC: USDC on Solana is not one of the pairs M0 has solver coverage
    // for, so it opens an order nobody fills. This is the covered Solana route.
    description: 'Ethereum → Solana · 1 USDC → XO (non-EVM receiver)',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: LIFI_CHAIN_ID_SOLANA,
    sendingAssetId: getAddress(ADDRESS_USDC_ETH),
    amount: '1',
    tokenOut: solanaAddressToBytes32(ADDRESS_XO_SOL),
    destinationIsSolana: true,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Solana',
      destinationAsset: ADDRESS_XO_SOL,
    },
    fallbackLimitPriceBps: 10,
  },
}

/**
 * Asks M0's Orchestration API what a solver would actually pay for this route,
 * restricted to `limit-order` — the only provider that settles through the OrderBook
 * this facet calls. Every other provider (portals, wormhole-cctp) is a different
 * contract entirely, so its quote would not describe the order we open.
 *
 * Returns null when M0 cannot quote the route — a route outside the solver allowlist, a
 * covered route in its uncovered direction, or an amountIn below the route's minimum.
 * See the coverage note in the header.
 */
const fetchM0LimitOrderQuote = async (
  route: IQuoteRoute,
  sendingAssetId: Address,
  amountIn: bigint,
  sender: Address,
  recipient: string
): Promise<IM0Quote | null> => {
  const apiKey = process.env.M0_API_KEY
  if (!apiKey) {
    consola.warn('M0_API_KEY is not set — cannot request a quote')
    return null
  }

  const response = await fetch(`${M0_API_URL}/quote`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({
      route: {
        source: { chain: route.sourceChain, address: sendingAssetId },
        destination: {
          chain: route.destinationChain,
          address: route.destinationAsset,
        },
      },
      amountIn: amountIn.toString(),
      sender,
      recipient,
      providers: { include: ['limit-order'] },
    }),
  })

  if (!response.ok) {
    // A gateway error is not always JSON. Parsing it unguarded would throw over the status
    // code, which is the part that actually explains the failure.
    let error: { code?: string; message?: string }
    try {
      error = (await response.json()) as { code?: string; message?: string }
    } catch {
      error = { message: response.statusText }
    }

    consola.warn(
      `M0 quote unavailable (HTTP ${response.status} ${
        error.code ?? 'unknown'
      }): ${error.message ?? ''}`
    )
    return null
  }

  // Quotes come back ranked by best amountOut, so the first is the one to take.
  const quotes = (await response.json()) as IM0QuoteResponse[]
  const best = quotes[0]
  if (!best) {
    consola.warn('M0 returned an empty quote list')
    return null
  }

  // An exclusive solver priced this leg for itself and is the only one obliged to fill
  // it, so the order has to name it. Opening with bytes32(0) instead leaves an open-fill
  // order at an exclusive quote's price, which is what nobody picks up.
  const exclusive = best.payloads
    .map((payload) => payload.solver)
    .find((solver): solver is IM0PayloadSolver => solver?.exclusive === true)

  return {
    amountOut: BigInt(best.amountOut),
    solver: exclusive
      ? solverToBytes32(exclusive.address, route.destinationChain)
      : ANY_SOLVER,
    solverName: exclusive?.name ?? null,
  }
}

/**
 * Encodes a quote's solver into `OrderParams.solver`.
 *
 * The solver is identified on the chain it fills on, so a Solana destination names it by
 * base58 pubkey, not by an EVM address — left-padding is only right for EVM. M0's own
 * reference calldata puts the base58-decoded 32 bytes in this slot, the same way it
 * encodes `recipient` and `tokenOut` for non-EVM.
 */
const solverToBytes32 = (address: string, destination: M0Chain): Hex =>
  destination === 'Solana'
    ? solanaAddressToBytes32(address)
    : zeroPadAddressToBytes32(getAddress(address))

/**
 * The limit price the order asks for. Prefers M0's own quote; falls back to a made-up
 * spread so the demo still exercises the facet if a route loses coverage.
 * The fallback is only a faithful exchange rate because every pair here is 6-decimals
 * to 6-decimals — a production caller always takes both sides from the quote.
 *
 * Every scenario quotes today, so the fallback should not fire. When it does it also
 * under-prices badly against same-chain behaviour: solvers charge a flat 3e6 there, so a
 * bps spread on a small order asks for far more than any solver would pay.
 */
const resolveLimitPrice = async (
  scenario: IScenarioConfig,
  amountIn: bigint,
  sender: Address,
  recipient: string
): Promise<IM0Quote> => {
  const quoted = await fetchM0LimitOrderQuote(
    scenario.quoteRoute,
    scenario.sendingAssetId,
    amountIn,
    sender,
    recipient
  )

  if (quoted !== null) {
    consola.success(
      `amountOut ${quoted.amountOut.toString()} — quoted by M0 (limit-order)`
    )
    consola.info(
      quoted.solverName === null
        ? 'Quote is open-fill: any solver may take it'
        : `Designated solver: ${quoted.solverName} (${quoted.solver})`
    )
    return quoted
  }

  const spreadBps = scenario.fallbackLimitPriceBps
  const amountOut = (amountIn * BigInt(10000 - spreadBps)) / 10000n
  if (amountOut === 0n)
    throw new Error(
      `Limit price rounds to zero for amountIn=${amountIn} and spread=${spreadBps}bps`
    )

  consola.warn(
    `Falling back to an arbitrary ${spreadBps}bps limit price (${amountOut.toString()}). ` +
      'No solver has quoted this route, so the order is unlikely to fill — it opens, ' +
      'escrows, and can be cancelled once fillDeadline passes.'
  )

  // No quote means no solver priced it, so there is none to designate.
  return { amountOut, solver: ANY_SOLVER, solverName: null }
}

/**
 * Resolves the destination-chain receiver as bytes32, plus the value bridgeData.receiver
 * has to carry (the NON_EVM_ADDRESS sentinel for non-EVM destinations).
 */
const resolveReceiver = (
  scenario: IScenarioConfig,
  callerAddress: Address
): {
  bridgeReceiver: Address
  receiverAddress: Hex
  // The same recipient in the destination chain's own text form, which is what
  // M0's quote API wants — it rejects an EVM address for an SVM destination.
  quoteRecipient: string
} => {
  if (!scenario.destinationIsSolana)
    return {
      bridgeReceiver: callerAddress,
      receiverAddress: zeroPadAddressToBytes32(callerAddress),
      quoteRecipient: callerAddress,
    }

  const solanaAddress = deriveSolanaAddress(
    getPrivateKeyForEnvironment(EnvironmentEnum.staging)
  )
  consola.info(`Derived Solana receiver: ${solanaAddress}`)

  return {
    bridgeReceiver: getAddress(NON_EVM_ADDRESS),
    receiverAddress: solanaAddressToBytes32(solanaAddress),
    quoteRecipient: solanaAddress,
  }
}

const cli = defineCommand({
  meta: {
    name: 'demoM0',
    description:
      'Open an M0 OrderBook order via the M0Facet. Pick a scenario with --scenario.',
  },
  args: {
    scenario: {
      type: 'string',
      description: `One of: ${SCENARIO_NAMES.join(' | ')}`,
      required: true,
    },
  },
  run: async ({ args }): Promise<void> => {
    if (!SCENARIO_NAMES.includes(args.scenario as Scenario))
      throw new Error(
        `Unknown scenario "${args.scenario}". Available: ${SCENARIO_NAMES.join(
          ', '
        )}`
      )

    const scenario = SCENARIOS[args.scenario as Scenario]
    consola.info(scenario.description)

    // Same-chain orders cancel locally, cross-chain ones on the destination chain, so the
    // closing reminder differs per scenario.
    const isSameChainOrder =
      scenario.destinationChainId === BigInt(scenario.sourceChainId)

    const { publicClient, walletClient, walletAccount, client } =
      await setupEnvironment(scenario.sourceChain, null)
    const callerAddress = walletAccount.address

    const deployments = await import(
      `../../deployments/${scenario.sourceChain}.staging.json`
    )
    const diamondAddress = getAddress(deployments.LiFiDiamond)

    consola.info(`From:    ${scenario.sourceChain}`)
    consola.info(`ToChain: ${scenario.destinationChainId}`)
    consola.info(`Caller:  ${callerAddress}`)
    consola.info(`Diamond: ${diamondAddress}`)

    // Reading the immutable proves the facet is cut into this diamond and yields the
    // OrderBook the destination can be pre-flighted against.
    let orderBookAddress: Address
    try {
      orderBookAddress = (await publicClient.readContract({
        address: diamondAddress,
        abi: M0Facet__factory.abi,
        functionName: 'M0_ORDER_BOOK',
      })) as Address
    } catch (error) {
      throw new Error(
        `Could not read M0_ORDER_BOOK() from ${diamondAddress} — is M0Facet cut into the ${
          scenario.sourceChain
        } staging diamond? (${String(error)})`
      )
    }
    consola.info(`OrderBook: ${orderBookAddress}`)

    // isDestinationSupported short-circuits to true for the local chain, so this also
    // confirms the same-chain scenario up front rather than at revert time.
    const m0DestinationChainId = scenario.destinationIsSolana
      ? M0_CHAIN_ID_SOLANA
      : Number(scenario.destinationChainId)
    const destinationSupported = (await publicClient.readContract({
      address: orderBookAddress,
      abi: IM0OrderBook__factory.abi,
      functionName: 'isDestinationSupported',
      args: [m0DestinationChainId],
    })) as boolean
    if (!destinationSupported)
      throw new Error(
        `OrderBook ${orderBookAddress} does not support destination chain ${m0DestinationChainId}`
      )

    const { bridgeReceiver, receiverAddress, quoteRecipient } = resolveReceiver(
      scenario,
      callerAddress
    )

    const bridgeData: ILiFi.BridgeDataStruct = {
      transactionId: `0x${randomBytes(32).toString('hex')}`,
      bridge: 'm0',
      integrator: 'lifi-demo',
      referrer: zeroAddress,
      sendingAssetId: scenario.sendingAssetId,
      receiver: bridgeReceiver,
      minAmount: 0n, // set below per branch
      destinationChainId: scenario.destinationChainId,
      hasSourceSwaps: scenario.preSwap !== undefined,
      hasDestinationCall: false,
    }

    const m0Data: M0Facet.M0DataStruct = {
      receiverAddress,
      // refundRecipient is paid inside this call (swap leftovers, excess native);
      // orderOwner is paid by the OrderBook much later, if the order is cancelled.
      refundRecipient: callerAddress,
      orderOwner: callerAddress,
      tokenOut: scenario.tokenOut,
      solver: ANY_SOLVER, // replaced below with the quote's solver, per branch
      amountOut: 0n, // set below per branch
      fillDeadline: Math.floor(Date.now() / 1000) + FILL_DEADLINE_SECONDS,
    }

    const m0Facet = getContract({
      address: diamondAddress,
      abi: M0Facet__factory.abi,
      client,
    })

    if (scenario.preSwap) {
      const preSwap = scenario.preSwap
      const fromAmount = BigNumber.from(preSwap.fromAmount.toString())

      const amounts = await getAmountsOutUniswap(
        preSwap.uniswapRouter,
        scenario.sourceChainId,
        [preSwap.fromToken, scenario.sendingAssetId],
        fromAmount
      )
      const expectedOut = BigNumber.from(amounts[1])
      const floor = expectedOut.mul(10000 - preSwap.slippageBps).div(10000)

      // bridgeData.minAmount is the declared swap floor, which is also what the facet
      // quotes amountOut against before scaling it by the realized swap output.
      bridgeData.minAmount = floor.toBigInt()
      const swapQuote = await resolveLimitPrice(
        scenario,
        floor.toBigInt(),
        callerAddress,
        quoteRecipient
      )
      m0Data.amountOut = swapQuote.amountOut
      m0Data.solver = swapQuote.solver

      consola.info(
        `Pre-swap: expected ${expectedOut.toString()}, floor ${floor.toString()} (${
          preSwap.slippageBps / 100
        }% slippage)`
      )
      consola.info(
        `amountOut ${m0Data.amountOut.toString()} — scaled on-chain by realized/floor`
      )

      const srcSwap = await getUniswapSwapDataERC20ToERC20(
        preSwap.uniswapRouter,
        scenario.sourceChainId,
        preSwap.fromToken,
        scenario.sendingAssetId,
        fromAmount,
        diamondAddress,
        true,
        floor.toNumber()
      )
      const swapData: LibSwap.SwapDataStruct[] = [
        { ...srcSwap, fromAmount: preSwap.fromAmount },
      ]

      const fromTokenContract = getContract({
        address: preSwap.fromToken,
        abi: ERC20__factory.abi,
        client: { public: publicClient, wallet: walletClient },
      })
      await ensureBalance(
        fromTokenContract,
        callerAddress,
        preSwap.fromAmount,
        publicClient
      )
      await ensureAllowance(
        fromTokenContract,
        callerAddress,
        diamondAddress,
        preSwap.fromAmount,
        publicClient
      )

      const hash = await executeTransaction(
        () =>
          (
            m0Facet.write as {
              swapAndStartBridgeTokensViaM0: (
                writeArgs: [
                  ILiFi.BridgeDataStruct,
                  LibSwap.SwapDataStruct[],
                  M0Facet.M0DataStruct
                ]
              ) => Promise<Hex>
            }
          ).swapAndStartBridgeTokensViaM0([bridgeData, swapData, m0Data]),
        'Swap + open M0 order',
        publicClient,
        true
      )
      consola.success(`tx hash: ${hash}`)
      await logFillStatusCommand(
        publicClient,
        hash,
        orderBookAddress,
        scenario.quoteRoute.sourceChain
      )
      logEscrowReminder(isSameChainOrder)
      return
    }

    const decimals = (await publicClient.readContract({
      address: scenario.sendingAssetId,
      abi: ERC20__factory.abi,
      functionName: 'decimals',
    })) as number
    const amountIn = parseUnits(scenario.amount, decimals)
    bridgeData.minAmount = amountIn
    const quote = await resolveLimitPrice(
      scenario,
      amountIn,
      callerAddress,
      quoteRecipient
    )
    m0Data.amountOut = quote.amountOut
    m0Data.solver = quote.solver

    consola.info(
      `amountIn ${amountIn.toString()}, limit price amountOut ${m0Data.amountOut.toString()}`
    )

    const tokenContract = getContract({
      address: scenario.sendingAssetId,
      abi: ERC20__factory.abi,
      client: { public: publicClient, wallet: walletClient },
    })
    await ensureBalance(tokenContract, callerAddress, amountIn, publicClient)
    await ensureAllowance(
      tokenContract,
      callerAddress,
      diamondAddress,
      amountIn,
      publicClient
    )

    // startBridgeTokensViaM0 is NOT payable: the OrderBook charges no native fee when
    // an order is opened.
    const hash = await executeTransaction(
      () =>
        (
          m0Facet.write as {
            startBridgeTokensViaM0: (
              writeArgs: [ILiFi.BridgeDataStruct, M0Facet.M0DataStruct]
            ) => Promise<Hex>
          }
        ).startBridgeTokensViaM0([bridgeData, m0Data]),
      'Open M0 order',
      publicClient,
      true
    )
    consola.success(`tx hash: ${hash}`)
    await logFillStatusCommand(
      publicClient,
      hash,
      orderBookAddress,
      scenario.quoteRoute.sourceChain
    )
    logEscrowReminder(isSameChainOrder)
  },
})

/**
 * Prints the command that reports whether the order actually filled.
 *
 * The tx hash only proves the order was OPENED — the fill happens later, off this chain
 * and outside this script — so the run is not meaningful to judge without this follow-up.
 * The orderId comes from the OrderBook's `OrderOpened`, where it is the first non-indexed
 * parameter; the signature is
 * `OrderOpened(bytes32,address,address,address,uint128,uint32,bytes32,uint128,bytes32,uint32)`.
 * Decoding just that one word avoids restating the whole event, whose parameter names are
 * not in any ABI we ship.
 */
async function logFillStatusCommand(
  publicClient: PublicClient,
  hash: Hex | null,
  orderBookAddress: Address,
  originChain: M0Chain
): Promise<void> {
  if (hash === null) return

  const receipt = await publicClient.getTransactionReceipt({ hash })
  const opened = receipt.logs.find(
    (log) =>
      getAddress(log.address) === getAddress(orderBookAddress) &&
      log.topics[0] === ORDER_OPENED_TOPIC
  )

  if (!opened) {
    consola.warn(
      'Could not find OrderOpened in the receipt — look the order up by tx hash instead.'
    )
    return
  }

  const orderId = slice(opened.data, 0, 32)
  consola.info(`orderId: ${orderId}`)
  consola.info(
    'Check whether it filled (want status COMPLETED and a non-zero amountOutFilled):\n' +
      `  curl -s -H "x-api-key: $M0_API_KEY" \\\n` +
      `    "${M0_API_URL}/orders/${originChain}/${orderId}" | jq`
  )
}

function logEscrowReminder(isSameChainOrder: boolean): void {
  if (isSameChainOrder) {
    consola.info(
      'Order opened — the funds are now in M0 escrow. A solver settles it on this same ' +
        'chain; if nobody fills it, the cancellation is local: before fillDeadline either ' +
        'the recipient or orderOwner can cancel, afterwards anyone can. It carries no ' +
        'Portal message, so msg.value must be 0 (a non-zero value reverts ' +
        'InvalidMsgValue), and the refund is paid to orderOwner immediately. ' +
        'See docs/M0Facet.md.'
    )
    return
  }

  consola.info(
    'Order opened — the funds are now in M0 escrow. A solver settles it on the ' +
      'destination chain; if nobody fills it, the cancellation has to be sent ON THE ' +
      'DESTINATION CHAIN (only the recipient before fillDeadline, anyone afterwards) ' +
      'with msg.value paying for the Portal message back, and the refund lands with ' +
      'orderOwner on this chain. See docs/M0Facet.md.'
  )
}

runMain(cli).catch((error) => {
  consola.error(error)
  process.exit(1)
})
