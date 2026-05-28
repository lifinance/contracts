/**
 * Demo for the SupersetFacet. Select scenario with `--scenario <name>`:
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario base-to-unichain
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario arbitrum-to-base
 *   bunx tsx script/demoScripts/demoSuperset.ts --scenario base-to-unichain-w-swap
 *
 * Executed runs:
 *   base-to-unichain        SRC https://basescan.org/tx/0x4ea0a142a2186a4399601ad1531fcf9256f26b7f1049cd4b727b7e47fe5eefa4
 *                           DST https://arbiscan.io/tx/0x4d6388b9c47984fe24984851e81f818958a3700934c560a66f38c9b86a7dd809
 *   arbitrum-to-base        (pending)
 *   base-to-unichain-w-swap (pending)
 */

import { randomBytes } from 'crypto'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { config } from 'dotenv'
import {
  encodeFunctionData,
  getAddress,
  getContract,
  parseAbi,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { ERC20__factory, SupersetFacet__factory } from '../../typechain'
import type { ILiFi, SupersetFacet } from '../../typechain'
import type { LibSwap } from '../../typechain/SupersetFacet.sol/SupersetFacet'
import { type SupportedChain } from '../common/types'

import {
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

type Scenario =
  | 'base-to-unichain'
  | 'arbitrum-to-base'
  | 'base-to-unichain-w-swap'

const SCENARIO_NAMES = [
  'base-to-unichain',
  'arbitrum-to-base',
  'base-to-unichain-w-swap',
] as const

interface IPreSwap {
  fromToken: Address
  fromAmount: bigint
}

const ADDRESS_UNISWAP_V2_BASE =
  '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891' as Address
const ADDRESS_WETH_BASE =
  '0x4200000000000000000000000000000000000006' as Address

const UNISWAP_V2_ABI = parseAbi([
  'function getAmountsOut(uint amountIn, address[] path) external view returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) external payable returns (uint[] memory amounts)',
])

const buildExactEthToErc20Swap = async (
  publicClient: PublicClient,
  ethAmount: bigint,
  receivingToken: Address,
  receiver: Address
): Promise<{ swap: LibSwap.SwapDataStruct; minOut: bigint }> => {
  const path: readonly Address[] = [ADDRESS_WETH_BASE, receivingToken]
  const amounts = (await publicClient.readContract({
    address: ADDRESS_UNISWAP_V2_BASE,
    abi: UNISWAP_V2_ABI,
    functionName: 'getAmountsOut',
    args: [ethAmount, path],
  })) as readonly bigint[]
  const expectedOut = amounts[1]
  if (expectedOut === undefined || expectedOut === 0n)
    throw new Error('Uniswap V2 returned zero output (no liquidity?)')
  const minOut = (expectedOut * 95n) / 100n
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60)
  const callData = encodeFunctionData({
    abi: UNISWAP_V2_ABI,
    functionName: 'swapExactETHForTokens',
    args: [minOut, path, receiver, deadline],
  })
  return {
    swap: {
      callTo: ADDRESS_UNISWAP_V2_BASE,
      approveTo: ADDRESS_UNISWAP_V2_BASE,
      sendingAssetId: zeroAddress,
      receivingAssetId: receivingToken,
      fromAmount: ethAmount,
      callData,
      requiresDeposit: true,
    },
    minOut,
  }
}

interface ISupersetParams {
  omniPath: Hex
  amountOutMin: bigint
  amountOutMinPercent: bigint
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
}

const SHARED = {
  receiver: '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3' as Address,
  refundAddress: '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3' as Address,
  fallbackEoA: '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3' as Address,
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
      amountOutMin: 1341n,
      amountOutMinPercent: 1348000000000000n,
      toEid: 30320, // Unichain
      options:
        '0x000301002101000000000000000000000000000000000000000000000000000025241fc03498',
      lzFee: 173694647215662n, // 20% buffer above quoted request fee
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
      amountOutMin: 1341n,
      amountOutMinPercent: 1348000000000000n,
      toEid: 30184, // Base
      options: '0x00030100110100000000000000000000000000030d40', // unused on hub branch (facet picks 7-arg hub ABI)
      lzFee: 35544130952448n, // 20% buffer; one LZ message: hub → Base
    },
  },

  'base-to-unichain-w-swap': {
    description:
      'Base → Unichain · ETH→USDC pre-swap on Base, then bridge USDC→WBTC',
    sourceChain: 'base',
    destinationChainId: 130,
    sourceToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC, post-swap
    amount: '1', // ignored when preSwap is present
    preSwap: {
      fromToken: zeroAddress, // native ETH
      fromAmount: parseEther('0.0005'), // ~$1–2 of ETH; swap is quoted live
    },
    superset: {
      omniPath:
        '0x0000000000000000000000000000000000000000000000000000000000000002000bb80000000000000000000000000000000000000000000000000000000000000003',
      amountOutMin: 1341n,
      amountOutMinPercent: 1348000000000000n,
      toEid: 30320,
      options:
        '0x000301002101000000000000000000000000000000000000000000000000000025241fc03498',
      lzFee: 173694647215662n,
    },
  },
}

function assertConfigured(s: IScenarioConfig): void {
  const missing: string[] = []
  if (s.superset.omniPath === '0x') missing.push('superset.omniPath')
  if (s.superset.options === '0x') missing.push('superset.options')
  if (s.superset.lzFee === 0n) missing.push('superset.lzFee')
  if (s.superset.amountOutMin === 0n) missing.push('superset.amountOutMin')
  if (s.preSwap && s.preSwap.fromAmount === 0n)
    missing.push('preSwap.fromAmount')
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
      amountOutMinPercent: scenario.superset.amountOutMinPercent,
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
      if (ps.fromToken !== zeroAddress)
        throw new Error('preSwap only supports native ETH input (Base)')

      const { swap, minOut } = await buildExactEthToErc20Swap(
        publicClient,
        ps.fromAmount,
        sourceTokenAddress,
        diamondAddress
      )
      bridgeData.minAmount = minOut
      const swapData: LibSwap.SwapDataStruct[] = [swap]

      const value = ps.fromAmount + scenario.superset.lzFee

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
            { value }
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
