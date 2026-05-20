/**
 * Demo script for bridging tokens via the SupersetFacet.
 *
 * Superset is a hub-and-spoke cross-chain DEX for stablecoins.
 *   - Hub:    Arbitrum (off-chain pricing via virtual Uniswap-V3 pools)
 *   - Spokes: Base, Unichain (user-facing entrypoints)
 *
 * This demo only constructs the SupersetData required by the facet. The
 * `path` bytes, `lzFee`, `options`, and `amountOutMin` are produced off-chain
 * by the LI.FI backend (which in turn queries Superset's on-chain quoters
 * via the SDK at https://github.com/superset-finance/sdk). They are
 * passed as static values here.
 *
 * Source chain defaults to Base; destination defaults to Unichain.
 *
 * Usage:
 *   bun script/demoScripts/demoSuperset.ts \
 *     [--from base] [--to unichain] [--token USDC] [--amount 100]
 */

import { randomBytes } from 'crypto'

import { consola } from 'consola'
import { config } from 'dotenv'
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
import { EnvironmentEnum, type SupportedChain } from '../common/types'

import {
  createContractObject,
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

/** LayerZero endpoint IDs for the spokes Superset supports today. */
const LAYERZERO_EIDS: Record<string, number> = {
  base: 30184,
  unichain: 30320,
}

interface IScriptArgs {
  from: string
  to: string
  token: string
  amount?: string
}

const parseArgs = (): IScriptArgs => {
  const argv = process.argv.slice(2)
  const getOpt = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined
  }
  return {
    from: (getOpt('from') ?? 'base').toLowerCase(),
    to: (getOpt('to') ?? 'unichain').toLowerCase(),
    token: (getOpt('token') ?? 'USDC').toUpperCase(),
    amount: getOpt('amount'),
  }
}

const toHex32 = (bytes: Uint8Array): Hex => {
  let hex = '0x'
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex as Hex
}

const main = async () => {
  const args = parseArgs()
  const amountHuman = args.amount ?? '100'

  const toEid = LAYERZERO_EIDS[args.to]
  if (!toEid)
    throw new Error(
      `Unknown destination "${args.to}". Add it to LAYERZERO_EIDS.`
    )

  const { publicClient, walletClient, walletAccount, client } =
    await setupEnvironment(
      args.from as SupportedChain,
      null,
      EnvironmentEnum.production
    )
  const callerAddress = walletAccount.address

  const deployments = await import(`../../deployments/${args.from}.json`)
  const diamondAddress = getAddress(deployments.LiFiDiamond)

  const supersetFacet = getContract({
    address: diamondAddress,
    abi: SupersetFacet__factory.abi,
    client,
  })

  consola.info('=== SupersetFacet Demo ===')
  consola.info(`From:     ${args.from}`)
  consola.info(`To:       ${args.to} (LZ EID ${toEid})`)
  consola.info(`Token:    ${args.token}`)
  consola.info(`Amount:   ${amountHuman}`)
  consola.info(`Caller:   ${callerAddress}`)

  // Resolve token + amount. Replace with real source-chain token addresses
  // (USDC on Base = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 etc.).
  const tokenAddress = getAddress(deployments[args.token] ?? zeroAddress)
  if (tokenAddress === zeroAddress)
    throw new Error(`No address for ${args.token} on ${args.from}`)

  const tokenContract = createContractObject(
    tokenAddress,
    ERC20__factory.abi,
    publicClient,
    walletClient
  )
  // Demo assumes stablecoin scope (USDC/USDT = 6 decimals); adjust per token.
  const decimals = (await publicClient.readContract({
    address: tokenAddress,
    abi: ERC20__factory.abi,
    functionName: 'decimals',
  })) as number
  const amount = parseUnits(amountHuman, decimals)

  const transactionId = toHex32(new Uint8Array(randomBytes(32)))

  const bridgeData: ILiFi.BridgeDataStruct = {
    transactionId,
    bridge: 'superset',
    integrator: 'ACME Devs',
    referrer: zeroAddress,
    sendingAssetId: tokenAddress,
    receiver: callerAddress,
    minAmount: amount,
    destinationChainId: BigInt(LAYERZERO_EIDS[args.to] ?? 0),
    hasSourceSwaps: false,
    hasDestinationCall: false,
  }

  // The path, amountOutMin, options, and lzFee are produced by the LI.FI
  // backend via Superset's quoter contracts (PoolManagerMessagingQuoter +
  // HubLocalTokensQuoterV2). Placeholders are used here — replace with real
  // values from the backend quote response.
  const supersetData: SupersetFacet.SupersetDataStruct = {
    path: '0x' as Hex, // packed omniTokenId(32) || fee(3) || omniTokenId(32)
    amountOutMin: 0n,
    amountOutMinPercent: 990000000000000000n, // 0.99e18 = 99%
    refundAddress: callerAddress as Address,
    fallbackEoA: callerAddress as Address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    toEid,
    options: '0x' as Hex,
    lzFee: 0n,
  }

  consola.warn(
    'This demo uses placeholder values for path/options/lzFee/amountOutMin.'
  )
  consola.warn(
    'Populate them via the LI.FI backend / Superset SDK before running.'
  )

  // Approve and bridge
  await ensureBalance(tokenContract, callerAddress, amount, publicClient)
  await ensureAllowance(
    tokenContract,
    callerAddress,
    diamondAddress,
    amount,
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
        value: BigInt(supersetData.lzFee.toString()),
      }),
    'Bridge tokens via Superset',
    publicClient,
    true
  )

  consola.success('Bridge transaction confirmed')
  consola.info(`Transaction hash: ${hash}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    consola.error('\nDemo failed')
    consola.error(error)
    process.exit(1)
  })
