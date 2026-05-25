/**
 * Demo for the SupersetFacet. Fill in the constants below and run with
 * `bunx tsx script/demoScripts/demoSuperset.ts`.
 */

import { randomBytes } from 'crypto'

import { defineCommand, runMain } from 'citty'
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
import { type SupportedChain } from '../common/types'

import {
  ensureAllowance,
  ensureBalance,
  executeTransaction,
  setupEnvironment,
} from './utils/demoScriptHelpers'

config()

// ─── Route ────────────────────────────────────────────────────────────────────
const SOURCE_CHAIN: SupportedChain = 'basesepolia' as SupportedChain
const DESTINATION_CHAIN_ID = 1301 // Unichain Sepolia
const SOURCE_TOKEN: Address = '0x90B9506cE63e31B68584f94e888Eb37bf108472d' // test-USD
const AMOUNT = '1'
const RECEIVER: Address = '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3'
const REFUND_ADDRESS: Address = '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3'
const FALLBACK_EOA: Address = '0x85A8F3cf6d255BD497Bd1Dd83a338Cce0B14C3B3'
const DEADLINE_SECONDS = 1200

// ─── Retrieved values (paste cast output here) ────────────────────────────────
const OMNI_PATH: Hex =
  '0x000000000000000000000000000000000000000000000000000000000000000e000bb8000000000000000000000000000000000000000000000000000000000000000c'
const AMOUNT_OUT_MIN = 750645737863094597n
const AMOUNT_OUT_MIN_PCT = 754417826998085023n
const TO_EID = 40333 // Unichain Sepolia
const OPTIONS: Hex =
  '0x00030100210100000000000000000000000000000000000000000000000000001b6f20cb06da'
const LZ_FEE = 17513267398348n
// ──────────────────────────────────────────────────────────────────────────────

function assertConfigured(): void {
  const missing: string[] = []
  if (RECEIVER === zeroAddress) missing.push('RECEIVER')
  if (REFUND_ADDRESS === zeroAddress) missing.push('REFUND_ADDRESS')
  if (FALLBACK_EOA === zeroAddress) missing.push('FALLBACK_EOA')
  if (OMNI_PATH === '0x') missing.push('OMNI_PATH')
  if (OPTIONS === '0x') missing.push('OPTIONS')
  if (missing.length > 0)
    throw new Error(`Missing constants: ${missing.join(', ')}`)
}

const cli = defineCommand({
  meta: {
    name: 'demoSuperset',
    description: 'Bridge tokens via SupersetFacet.',
  },
  args: {},
  run: async () => {
    assertConfigured()

    const { publicClient, walletClient, walletAccount, client } =
      await setupEnvironment(SOURCE_CHAIN, null)
    const callerAddress = walletAccount.address

    const deployments = await import(`../../deployments/${SOURCE_CHAIN}.json`)
    const diamondAddress = getAddress(deployments.LiFiDiamond)
    const tokenAddress = getAddress(SOURCE_TOKEN)

    const decimals = (await publicClient.readContract({
      address: tokenAddress,
      abi: ERC20__factory.abi,
      functionName: 'decimals',
    })) as number
    const amountIn = parseUnits(AMOUNT, decimals)

    consola.info(`From:    ${SOURCE_CHAIN}`)
    consola.info(`ToChain: ${DESTINATION_CHAIN_ID}`)
    consola.info(`Token:   ${tokenAddress}`)
    consola.info(`Amount:  ${AMOUNT}`)
    consola.info(`Caller:  ${callerAddress}`)

    const transactionId = `0x${randomBytes(32).toString('hex')}` as Hex

    const bridgeData: ILiFi.BridgeDataStruct = {
      transactionId,
      bridge: 'superset',
      integrator: 'ACME Devs',
      referrer: zeroAddress,
      sendingAssetId: tokenAddress,
      receiver: getAddress(RECEIVER),
      minAmount: amountIn,
      destinationChainId: BigInt(DESTINATION_CHAIN_ID),
      hasSourceSwaps: false,
      hasDestinationCall: false,
    }

    const supersetData: SupersetFacet.SupersetDataStruct = {
      path: OMNI_PATH,
      amountOutMin: AMOUNT_OUT_MIN,
      amountOutMinPercent: AMOUNT_OUT_MIN_PCT,
      refundAddress: getAddress(REFUND_ADDRESS),
      fallbackEoA: getAddress(FALLBACK_EOA),
      deadline: BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS),
      toEid: TO_EID,
      options: OPTIONS,
      lzFee: LZ_FEE,
    }

    const tokenContract = getContract({
      address: tokenAddress,
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

    const supersetFacet = getContract({
      address: diamondAddress,
      abi: SupersetFacet__factory.abi,
      client,
    })

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

    consola.success(`tx hash: ${hash}`)
  },
})

runMain(cli).catch((error) => {
  consola.error(error)
  process.exit(1)
})
