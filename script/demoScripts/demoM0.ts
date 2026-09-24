/**
 * Demo for the M0Facet. Select a scenario with `--scenario <name>`:
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-to-base
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-to-base-w-swap
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-samechain
 *   bunx tsx script/demoScripts/demoM0.ts --scenario mainnet-to-solana
 *
 * The M0 OrderBook escrows the sending asset and returns — a solver settles the order
 * later on the destination chain. A successful run therefore only proves the order was
 * OPENED; the fill (or the cancellation once `fillDeadline` passes) happens outside this
 * script. See docs/M0Facet.md.
 *
 * `amountOut` is a limit price, not a slippage floor. It is taken from M0's Orchestration
 * API (`POST /quote`, provider `limit-order`), which needs `M0_API_KEY` in `.env`.
 *
 * COVERAGE, as probed on 2026-09-24 against `GET /orders` and `POST /quote`:
 *
 *   - `limit-order` quotes SAME-CHAIN routes only, and its payload targets the OrderBook
 *     this facet calls. Live pairs seen: Ethereum USDC<->USDat, wM->USDC; Arbitrum
 *     CUSD<->USDC and CUSD<->PYUSD; Base mrUSD/AUSD/wM<->USDC.
 *   - CROSS-CHAIN returns 404 `NoQuotesAvailable` on every pair and size tried (wM, USDC
 *     and USDat out of Ethereum/Base/Arbitrum, at 5e6 / 1e8 / 5e9). The OrderBook itself
 *     supports it — `/orders` still holds Base->Ethereum orders from May and August —
 *     but no solver quotes it today.
 *   - Pricing is fee = max(3_000_000, 3bps), so it is flat below 10_000 units and
 *     proportional above. The minimum is exactly 4e6: 3_999_999 is refused and 4e6
 *     quotes 1e6 out, i.e. the fee must leave at least 1e6. Because the fee is flat in
 *     that range, a run costs 3 units whether you send 4 or 10_000 — size only changes
 *     the balance you have to hold, not what you lose.
 *
 * A quote also names its solver, and a same-chain quote comes back `exclusive: true` —
 * that solver priced the leg for itself and is the only one obliged to fill it, so it
 * has to become the order's `designatedSolver`. Opening with bytes32(0) instead leaves
 * an open-fill order at an exclusive quote's price, which nobody picks up: it just sits
 * at CREATED until fillDeadline. Every order in `/orders` names a solver.
 *
 * So the same-chain scenario prices off a real quote, and the cross-chain ones fall back
 * to an arbitrary limit price and are unlikely to be filled by anyone.
 *
 * Verified staging run (2026-09-24), `mainnet-samechain`: 4 USDC -> 1 wM on Ethereum,
 * filled by Farsight Solver two blocks (~24s) after the order opened. The 3 USDC spread is
 * the solver's flat fee, not slippage. The Diamond retained nothing — it holds the USDC
 * only between depositAsset and openOrder, inside the one transaction.
 *   open: https://etherscan.io/tx/0x23d9328cc72a4a35a3a7309a1f046be147404e83209ca808111d4871d3f91be8
 *   fill: https://etherscan.io/tx/0xf7afafb6ac5304a370b4055ff9bc739179d2b0cc66b0156fb45e08b3b2373b6b
 *   order 0xf84df03882ed233400682549f7607ccddd293aba8c2b98365fdef152ca1cbc5d
 *
 * The run before it is the counter-example for the solver rule above: same route, same
 * price, opened with bytes32(0), never filled, cancelled after fillDeadline for a full
 * refund (order 0x719c928678c9073f20339342f1adb290a00f85f2f14cd9c48f53000aac50a239).
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
  zeroAddress,
  type Address,
  type Hex,
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
  ADDRESS_USDC_BASE,
  ADDRESS_USDC_ETH,
  ADDRESS_USDC_SOL,
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

// WrappedM by M0 on Ethereum (6 decimals) — the same-chain scenario's tokenOut.
const ADDRESS_WM_ETH = '0x437cc33344a0B27A429f795ff6B469C72698B291'

// M0's Orchestration API. Needs M0_API_KEY in .env; see the coverage note above.
const M0_API_URL =
  process.env.M0_API_URL || 'https://gateway.m0.xyz/v1/orchestration'

type Scenario =
  | 'mainnet-to-base'
  | 'mainnet-to-base-w-swap'
  | 'mainnet-samechain'
  | 'mainnet-to-solana'

const SCENARIO_NAMES = [
  'mainnet-to-base',
  'mainnet-to-base-w-swap',
  'mainnet-samechain',
  'mainnet-to-solana',
] as const

interface IPreSwap {
  fromToken: Address
  fromAmount: bigint // exact-input pre-swap; the floor is derived live with slippageBps
  slippageBps: number // basis points (e.g. 300 = 3%)
  uniswapRouter: Address
}

/// Chain names as M0's Orchestration API spells them, which is not our chain ids.
type M0Chain = 'Ethereum' | 'Base' | 'Arbitrum' | 'Solana'

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
  'mainnet-to-base': {
    description: 'Ethereum → Base · 1 USDC → USDC (cross-chain order)',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: 8453n,
    sendingAssetId: getAddress(ADDRESS_USDC_ETH),
    amount: '1',
    tokenOut: zeroPadAddressToBytes32(ADDRESS_USDC_BASE),
    destinationIsSolana: false,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Base',
      destinationAsset: ADDRESS_USDC_BASE,
    },
    fallbackLimitPriceBps: 10,
  },

  'mainnet-to-base-w-swap': {
    description:
      'Ethereum → Base · USDT→USDC pre-swap on Ethereum, then bridge USDC → USDC',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: 8453n,
    sendingAssetId: getAddress(ADDRESS_USDC_ETH), // post-swap token
    amount: '1', // ignored: the pre-swap output decides amountIn
    tokenOut: zeroPadAddressToBytes32(ADDRESS_USDC_BASE),
    destinationIsSolana: false,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Base',
      destinationAsset: ADDRESS_USDC_BASE,
    },
    fallbackLimitPriceBps: 10,
    preSwap: {
      fromToken: getAddress(ADDRESS_USDT_ETH),
      fromAmount: 1_000_000n, // 1 USDT
      // Exact-input swap: the realized output exceeds the declared floor by roughly
      // slippageBps, which is what exercises the facet's amountOut scaling.
      slippageBps: 300,
      uniswapRouter: getAddress(ADDRESS_UNISWAP_ETH),
    },
  },

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

  'mainnet-to-solana': {
    description: 'Ethereum → Solana · 1 USDC → USDC (non-EVM receiver)',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: LIFI_CHAIN_ID_SOLANA,
    sendingAssetId: getAddress(ADDRESS_USDC_ETH),
    amount: '1',
    tokenOut: solanaAddressToBytes32(ADDRESS_USDC_SOL),
    destinationIsSolana: true,
    quoteRoute: {
      sourceChain: 'Ethereum',
      destinationChain: 'Solana',
      destinationAsset: ADDRESS_USDC_SOL,
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
 * Returns null when M0 cannot quote the route — today that means any cross-chain route,
 * or an amountIn too small to clear the flat fee. See the coverage note in the header.
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
    const error = (await response.json()) as { code?: string; message?: string }
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
      ? zeroPadAddressToBytes32(getAddress(exclusive.address))
      : ANY_SOLVER,
    solverName: exclusive?.name ?? null,
  }
}

/**
 * The limit price the order asks for. Prefers M0's own quote; falls back to a made-up
 * spread on the routes no solver quotes, so the demo still exercises the facet.
 * The fallback is only a faithful exchange rate because every pair here is 6-decimals
 * to 6-decimals — a production caller always takes both sides from the quote.
 *
 * Note the fallback under-prices badly against live behaviour: solvers charge a flat
 * 3e6, so a bps spread on a small order asks for far more than any solver would pay.
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
    logEscrowReminder(isSameChainOrder)
  },
})

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
