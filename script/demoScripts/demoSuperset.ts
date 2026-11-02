/**
 * Demo for the SupersetFacet. Select scenario with `--scenario <name>`:
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario base-to-unichain
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario arbitrum-to-base
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario base-to-unichain-w-swap
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario arbitrum-samechain-dex
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario base-samechain-dex
 *
 * Executed runs (cross-chain):
 *   base-to-unichain        SRC https://basescan.org/tx/0x89c55da51e3461637cc5a17371c23417d4600f073659d7ba407694e022f263f2
 *                           DST https://uniscan.xyz/tx/0xe2702ba8c1d45f3bc7a1ce94c9193538389d84037eeadab49a8e375db64fe040
 *   arbitrum-to-base        SRC https://arbiscan.io/tx/0x4a087bf8a7e6f4658c5f2d0dac9d9d6e783691a65d11822153f3a8fa2482610e
 *                           DST https://basescan.org/tx/0x10eabe39174e6426a49d9145ec59af580f26958fc89cffe75259c4d973d7cbd5
 *   base-to-unichain-w-swap SRC https://basescan.org/tx/0x446053ee8e5b2400bf46eef45188f3289dce8333c0cbe0cc635cbf5a1eca3ce9
 *                           DST https://uniscan.xyz/tx/0x905d8ca1a6a61c31049a6f7e0e40be78b66872d4870d84a9bcba2d2648c35c27
 *
 * Same-chain (DEX) scenarios — `destinationChainId == sourceChainId`:
 *   arbitrum-samechain-dex  Hub source → atomic `HubPoolManager.exactInput`; no LayerZero
 *                           message, so `lzFee = 0` and `toEid`/`fallbackEoA`/`options`
 *                           are unused. Path + amountOutMin below are a real, live-quoted
 *                           USDC→tGBP route (see SupersetFacet.HubFork.t.sol, same route).
 *   base-samechain-dex      Spoke source → `SpokePoolManager.multiHopSwap` (LZ round-trip
 *                           source→hub→source). Still needs real `options` + `lzFee`; the
 *                           values below are carried over from the Base→hub leg of
 *                           `base-to-unichain` and cover only one message, so this
 *                           scenario is marked `requiresRequote` and refuses to run
 *                           without `--force` until re-quoted (EXBE-484).
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

import { ERC20__factory, SupersetFacet__factory } from '../../typechain'
import type { ILiFi, SupersetFacet } from '../../typechain'
import type { LibSwap } from '../../typechain/SupersetFacet'
import { type SupportedChain } from '../common/types'

import {
  ADDRESS_UNISWAP_BASE,
  ADDRESS_WETH_BASE,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  getAmountsOutUniswap,
  getUniswapSwapDataERC20ToERC20,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

type Scenario =
  | 'base-to-unichain'
  | 'arbitrum-to-base'
  | 'base-to-unichain-w-swap'
  | 'arbitrum-samechain-dex'
  | 'base-samechain-dex'

const SCENARIO_NAMES = [
  'base-to-unichain',
  'arbitrum-to-base',
  'base-to-unichain-w-swap',
  'arbitrum-samechain-dex',
  'base-samechain-dex',
] as const

// Source-chain IDs, used to detect same-chain (DEX) routes at runtime.
const SOURCE_CHAIN_IDS: Partial<Record<SupportedChain, number>> = {
  base: 8453,
  arbitrum: 42161,
  unichain: 130,
}

// Superset's hub chain. Mirrors the facet's `IS_HUB` (derived on-chain from
// `block.chainid == 42161`), so hub-only branches stay in sync with the contract.
const HUB_CHAIN: SupportedChain = 'arbitrum'

interface IPreSwap {
  fromToken: Address
  fromAmount: bigint // exact-input pre-swap; minAmountOut derived live with slippageBps
  slippageBps: number // basis points (e.g. 300 = 3%)
}

interface ISupersetParams {
  omniPath: Hex
  amountOutMin: bigint
  toEid: number
  options: Hex
  lzFee: bigint
}

interface IScenarioConfig {
  description: string
  sourceChain: SupportedChain
  destinationChainId: number
  sourceToken: Address // token the bridge consumes (= post-swap output if preSwap present)
  amount: string // human-readable; ignored when preSwap is present
  preSwap?: IPreSwap
  superset: ISupersetParams
  // Set when the scenario's LayerZero params are known-placeholder values that
  // would underpay on-chain. Execution is blocked unless `--force` is passed.
  requiresRequote?: boolean
}

const SHARED = {
  receiver: '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3' as Address,
  refundAddress: '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3' as Address,
  fallbackEoA: '0x34E7db45783b50F4e7764258d0Dc0400c3539A57' as Address,
  deadlineSeconds: 1800, // 30 minutes
}

// Quoted off-band; opaque to the script.
const SCENARIOS: Record<Scenario, IScenarioConfig> = {
  'base-to-unichain': {
    description: 'Base → Unichain · 1 USDC → WBTC (spoke source, cross-chain)',
    sourceChain: 'base',
    destinationChainId: 130,
    sourceToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    amount: '1',
    superset: {
      omniPath:
        '0x0000000000000000000000000000000000000000000000000000000000000002000bb80000000000000000000000000000000000000000000000000000000000000003',
      amountOutMin: 1472n, // off-band hub quote for 1 USDC in, minus 1% slippage
      toEid: 30320, // Unichain
      options:
        '0x0003010021010000000000000000000000000000000000000000000000000000275ebff3b07d',
      lzFee: 181180803718221n, // 20% buffer above quoted request fee (raw: 150984003098517)
    },
  },

  'arbitrum-to-base': {
    description: 'Arbitrum → Base · 1 USDC → WBTC (hub source, cross-chain)',
    sourceChain: 'arbitrum',
    destinationChainId: 8453,
    sourceToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC on Arbitrum
    amount: '1',
    superset: {
      omniPath:
        '0x0000000000000000000000000000000000000000000000000000000000000002000bb80000000000000000000000000000000000000000000000000000000000000003',
      amountOutMin: 1472n, // off-band hub quote for 1 USDC in, minus 1% slippage
      toEid: 30184, // Base
      options: '0x00030100110100000000000000000000000000030d40', // unused on hub branch (facet picks 7-arg hub ABI)
      lzFee: 37644833027306n, // 20% buffer above one-message hub → Base quote (raw: 31370694189421)
    },
  },

  'base-to-unichain-w-swap': {
    description:
      'Base → Unichain · WETH→USDC pre-swap on Base, then bridge USDC→WBTC',
    sourceChain: 'base',
    destinationChainId: 130,
    sourceToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC, post-swap
    amount: '1', // ignored when preSwap is present
    preSwap: {
      fromToken: getAddress(ADDRESS_WETH_BASE),
      // Exact-input swap: actual USDC out exceeds declared minAmountOut by
      // ~slippageBps, which forces the facet's positive-slippage scaling path
      // for amountOutMin. Use a small WETH amount to keep the demo cheap.
      fromAmount: 500_000_000_000_000n, // 0.0005 WETH (≈ 0.93 USDC at current quote)
      slippageBps: 300, // 3% slippage tolerance on pre-swap output
    },
    superset: {
      omniPath:
        '0x0000000000000000000000000000000000000000000000000000000000000002000bb80000000000000000000000000000000000000000000000000000000000000003',
      // Calibrated off-band against the declared bridge floor (= pre-swap
      // minAmountOut at today's WETH/USDC quote). Facet scales this up by
      // (actualPostSwap / declared) before forwarding, so the on-chain floor
      // tracks pre-swap positive slippage while keeping the same buffer below
      // the hub's expected output. Re-calibrate if WETH/USDC drifts materially
      // between runs.
      amountOutMin: 1308n, // off-band hub quote for declared bridge floor in, minus 3% slippage
      toEid: 30320,
      options:
        '0x0003010021010000000000000000000000000000000000000000000000000000275ebff3b07d',
      lzFee: 181180803718221n, // 20% buffer above quoted request fee (raw: 150984003098517)
    },
  },

  'arbitrum-samechain-dex': {
    description:
      'Arbitrum → Arbitrum · 1 USDC → tGBP (hub source, same-chain DEX via exactInput)',
    sourceChain: 'arbitrum',
    destinationChainId: 42161, // == source: same-chain (DEX) route
    sourceToken: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // USDC on Arbitrum
    amount: '1',
    superset: {
      // omniId(2=USDC) || fee(500) || omniId(4=tGBP); resolved to local
      // addresses on-chain, then swapped atomically via HubPoolManager.exactInput.
      omniPath:
        '0x00000000000000000000000000000000000000000000000000000000000000020001f40000000000000000000000000000000000000000000000000000000000000004',
      amountOutMin: 740000000000000000n, // ~0.74 tGBP; live quote ≈0.748 tGBP per 1 USDC, ~1% floor
      toEid: 0, // unused on hub same-chain (exactInput takes no destination EID)
      options: '0x', // unused; no LayerZero message on the atomic hub path
      lzFee: 0n, // atomic — no LayerZero fee
    },
  },

  'base-samechain-dex': {
    description:
      'Base → Base · 1 USDC → WBTC (spoke source, same-chain DEX via multiHopSwap round-trip)',
    sourceChain: 'base',
    destinationChainId: 8453, // == source: same-chain (DEX) route
    sourceToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    amount: '1',
    superset: {
      omniPath:
        '0x0000000000000000000000000000000000000000000000000000000000000002000bb80000000000000000000000000000000000000000000000000000000000000003',
      amountOutMin: 1472n, // off-band hub quote for 1 USDC in, minus 1% slippage
      toEid: 0, // unused on spoke same-chain (multiHopSwap takes no destination EID)
      // NOTE: options + lzFee below are carried over from the Base→hub leg of
      // `base-to-unichain` and only cover ONE message — the spoke same-chain
      // round-trip (source→hub→source) needs more. Must be re-quoted against a
      // live same-chain quote (EXBE-484) before a real run; `requiresRequote`
      // below blocks execution until then.
      options:
        '0x0003010021010000000000000000000000000000000000000000000000000000275ebff3b07d',
      lzFee: 181180803718221n,
    },
    // Placeholder LZ params would underpay the round-trip and stall at the LZ
    // layer. Require an explicit --force to run this against mainnet.
    requiresRequote: true,
  },
}

function assertConfigured(s: IScenarioConfig): void {
  const missing: string[] = []
  // Hub same-chain (exactInput) is atomic: no LayerZero message, so `options`
  // and `lzFee` are legitimately empty/zero and must not be flagged as missing.
  const isHubSameChain =
    s.destinationChainId === SOURCE_CHAIN_IDS[s.sourceChain] &&
    s.sourceChain === HUB_CHAIN
  if (s.superset.omniPath === '0x') missing.push('superset.omniPath')
  if (!isHubSameChain && s.superset.options === '0x')
    missing.push('superset.options')
  if (!isHubSameChain && s.superset.lzFee === 0n) missing.push('superset.lzFee')
  if (s.superset.amountOutMin === 0n) missing.push('superset.amountOutMin')
  if (s.preSwap) {
    if (s.preSwap.fromAmount === 0n) missing.push('preSwap.fromAmount')
    if (s.preSwap.slippageBps <= 0 || s.preSwap.slippageBps >= 10000)
      missing.push('preSwap.slippageBps')
  }
  if (missing.length > 0)
    throw new Error(`Scenario incomplete: ${missing.join(', ')}`)
}

const cli = defineCommand({
  meta: {
    name: 'demoSuperset',
    description:
      'Bridge tokens via SupersetFacet. Pick a scenario with --scenario.',
  },
  args: {
    scenario: {
      type: 'string',
      description: `One of: ${SCENARIO_NAMES.join(' | ')}`,
      required: true,
    },
    force: {
      type: 'boolean',
      description:
        'Run a scenario whose LayerZero params are known placeholders (see requiresRequote)',
      default: false,
    },
  },
  run: async ({ args }) => {
    if (!SCENARIO_NAMES.includes(args.scenario as Scenario))
      throw new Error(
        `Unknown scenario "${args.scenario}". Available: ${SCENARIO_NAMES.join(
          ', '
        )}`
      )
    const scenario = SCENARIOS[args.scenario as Scenario]
    assertConfigured(scenario)

    // Fail fast rather than broadcasting a tx that underpays the LayerZero fee
    // and stalls mid-flight (funds escrowed on the spoke, no delivery).
    if (scenario.requiresRequote && !args.force)
      throw new Error(
        `Scenario "${args.scenario}" still carries placeholder LayerZero params ` +
          `(options/lzFee) that would underpay on-chain. Re-quote them against a ` +
          `live same-chain quote (EXBE-484) first, or pass --force to run anyway.`
      )

    consola.info(scenario.description)

    const { publicClient, walletClient, walletAccount, client } =
      await setupEnvironment(scenario.sourceChain, null)
    const callerAddress = walletAccount.address

    const deployments = await import(
      `../../deployments/${scenario.sourceChain}.staging.json`
    )
    const diamondAddress = getAddress(deployments.LiFiDiamond)
    const sourceTokenAddress = getAddress(scenario.sourceToken)

    consola.info(`From:    ${scenario.sourceChain}`)
    consola.info(`ToChain: ${scenario.destinationChainId}`)
    consola.info(`Caller:  ${callerAddress}`)
    consola.info(`Diamond: ${diamondAddress}`)

    const transactionId = `0x${randomBytes(32).toString('hex')}` as Hex

    const bridgeData: ILiFi.BridgeDataStruct = {
      transactionId,
      bridge: 'superset',
      integrator: 'lifi-demo',
      referrer: zeroAddress,
      sendingAssetId: sourceTokenAddress,
      receiver: getAddress(SHARED.receiver),
      minAmount: 0n, // set below per branch
      destinationChainId: BigInt(scenario.destinationChainId),
      hasSourceSwaps: scenario.preSwap !== undefined,
      hasDestinationCall: false,
    }

    const supersetData: SupersetFacet.SupersetDataStruct = {
      path: scenario.superset.omniPath,
      amountOutMin: scenario.superset.amountOutMin,
      refundAddress: getAddress(SHARED.refundAddress),
      fallbackEoA: getAddress(SHARED.fallbackEoA),
      deadline: BigInt(Math.floor(Date.now() / 1000) + SHARED.deadlineSeconds),
      toEid: scenario.superset.toEid,
      options: scenario.superset.options,
      lzFee: scenario.superset.lzFee,
    }

    const supersetFacet = getContract({
      address: diamondAddress,
      abi: SupersetFacet__factory.abi,
      client,
    })

    if (scenario.preSwap) {
      const ps = scenario.preSwap
      const fromAmountBN = BigNumber.from(ps.fromAmount.toString())

      // Live-quote the expected USDC output and derive the slippage floor.
      // Setting bridgeData.minAmount = declared floor (not the expected output)
      // is what gives the facet a measurable positive-slippage ratio when
      // actualPostSwap > declared floor.
      const amounts = await getAmountsOutUniswap(
        ADDRESS_UNISWAP_BASE,
        8453,
        [getAddress(ps.fromToken), sourceTokenAddress],
        fromAmountBN
      )
      const expectedOut = BigNumber.from(amounts[1])
      const minAmountOutBN = expectedOut.mul(10000 - ps.slippageBps).div(10000)
      const minAmountOut = minAmountOutBN.toNumber() // safe for sub-billion USDC values

      consola.info(
        `Pre-swap: expected ${expectedOut.toString()}, floor ${minAmountOut} (${
          ps.slippageBps / 100
        }% slippage)`
      )
      consola.info(
        `Expected scaled amountOutMin ≈ ${
          (scenario.superset.amountOutMin * expectedOut.toBigInt()) /
          minAmountOutBN.toBigInt()
        }`
      )

      const srcSwap = await getUniswapSwapDataERC20ToERC20(
        ADDRESS_UNISWAP_BASE,
        8453,
        getAddress(ps.fromToken),
        sourceTokenAddress,
        fromAmountBN,
        diamondAddress,
        true,
        minAmountOut
      )

      const swapData: LibSwap.SwapDataStruct[] = [
        { ...srcSwap, fromAmount: BigInt(srcSwap.fromAmount.toString()) },
      ]
      bridgeData.minAmount = BigInt(minAmountOutBN.toString())

      const fromTokenContract = getContract({
        address: getAddress(ps.fromToken),
        abi: ERC20__factory.abi,
        client: { public: publicClient, wallet: walletClient },
      })
      await ensureBalance(
        fromTokenContract,
        callerAddress,
        ps.fromAmount,
        publicClient
      )
      await ensureAllowance(
        fromTokenContract,
        callerAddress,
        diamondAddress,
        ps.fromAmount,
        publicClient
      )

      const hash = await executeTransaction(
        () =>
          (
            supersetFacet.write as {
              swapAndStartBridgeTokensViaSuperset: (
                args: [
                  ILiFi.BridgeDataStruct,
                  LibSwap.SwapDataStruct[],
                  SupersetFacet.SupersetDataStruct
                ],
                options?: { value: bigint }
              ) => Promise<Hex>
            }
          ).swapAndStartBridgeTokensViaSuperset(
            [bridgeData, swapData, supersetData],
            { value: scenario.superset.lzFee }
          ),
        'Swap + bridge via Superset',
        publicClient,
        true
      )
      consola.success(`tx hash: ${hash}`)
      return
    }

    // Bridge-only path
    const decimals = (await publicClient.readContract({
      address: sourceTokenAddress,
      abi: ERC20__factory.abi,
      functionName: 'decimals',
    })) as number
    const amountIn = parseUnits(scenario.amount, decimals)
    bridgeData.minAmount = amountIn

    const tokenContract = getContract({
      address: sourceTokenAddress,
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

    const hash = await executeTransaction(
      () =>
        (
          supersetFacet.write as {
            startBridgeTokensViaSuperset: (
              args: [ILiFi.BridgeDataStruct, SupersetFacet.SupersetDataStruct],
              options?: { value: bigint }
            ) => Promise<Hex>
          }
        ).startBridgeTokensViaSuperset([bridgeData, supersetData], {
          value: scenario.superset.lzFee,
        }),
      'Bridge tokens via Superset',
      publicClient,
      true
    )
    consola.success(`tx hash: ${hash}`)
  },
})

runMain(cli).catch((error) => {
  consola.error(error)
  process.exit(1)
})
