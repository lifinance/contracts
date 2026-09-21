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
 * `amountOut` is a limit price, not a slippage floor: the scenarios below derive it from
 * `amountIn` and a solver spread, which is only a faithful exchange rate because every
 * pair here is 6-decimals to 6-decimals. A production caller takes both sides from the
 * backend quote.
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

interface IScenarioConfig {
  description: string
  sourceChain: SupportedChain
  sourceChainId: number
  destinationChainId: bigint // LI.FI chain id (Solana uses LIFI_CHAIN_ID_SOLANA)
  sendingAssetId: Address // the escrowed token, i.e. the post-swap token when preSwap is set
  amount: string // human-readable; ignored when preSwap is set
  tokenOut: Hex // destination token as bytes32
  destinationIsSolana: boolean
  solverSpreadBps: number // limit price = amountIn minus this spread
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
    solverSpreadBps: 10,
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
    solverSpreadBps: 10,
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
      'Ethereum → Ethereum · 1 USDC → WrappedM (same-chain order, asynchronous escrow)',
    sourceChain: 'mainnet',
    sourceChainId: 1,
    destinationChainId: 1n, // == source: same-chain order, allowed on purpose
    sendingAssetId: getAddress(ADDRESS_USDC_ETH),
    amount: '1',
    tokenOut: zeroPadAddressToBytes32(ADDRESS_WM_ETH),
    destinationIsSolana: false,
    solverSpreadBps: 10,
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
    solverSpreadBps: 10,
  },
}

/**
 * Derives the limit price the order asks for: amountIn minus the solver spread.
 * Both sides are 6-decimals in every scenario, so no decimal conversion is needed.
 */
const deriveAmountOut = (amountIn: bigint, spreadBps: number): bigint => {
  const amountOut = (amountIn * BigInt(10000 - spreadBps)) / 10000n
  if (amountOut === 0n)
    throw new Error(
      `Limit price rounds to zero for amountIn=${amountIn} and spread=${spreadBps}bps`
    )

  return amountOut
}

/**
 * Resolves the destination-chain receiver as bytes32, plus the value bridgeData.receiver
 * has to carry (the NON_EVM_ADDRESS sentinel for non-EVM destinations).
 */
const resolveReceiver = (
  scenario: IScenarioConfig,
  callerAddress: Address
): { bridgeReceiver: Address; receiverAddress: Hex } => {
  if (!scenario.destinationIsSolana)
    return {
      bridgeReceiver: callerAddress,
      receiverAddress: zeroPadAddressToBytes32(callerAddress),
    }

  const solanaAddress = deriveSolanaAddress(
    getPrivateKeyForEnvironment(EnvironmentEnum.staging)
  )
  consola.info(`Derived Solana receiver: ${solanaAddress}`)

  return {
    bridgeReceiver: getAddress(NON_EVM_ADDRESS),
    receiverAddress: solanaAddressToBytes32(solanaAddress),
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

    const { bridgeReceiver, receiverAddress } = resolveReceiver(
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
      solver: ANY_SOLVER,
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
      m0Data.amountOut = deriveAmountOut(
        floor.toBigInt(),
        scenario.solverSpreadBps
      )

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
    m0Data.amountOut = deriveAmountOut(amountIn, scenario.solverSpreadBps)

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
