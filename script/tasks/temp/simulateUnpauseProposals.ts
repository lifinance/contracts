/**
 * Dry-runs the Phase 2b unpause proposals stored in MongoDB to confirm they
 * will execute successfully the moment the Safe reaches its signature threshold.
 *
 * IMPORTANT — there is NO timelock delay on this path. The proposals target
 * `LiFiTimelockController.unpauseDiamond(address[])`, which is the bypass-minDelay
 * function (see `src/Security/LiFiTimelockController.sol:70-82`). At execution
 * time everything happens in a single Safe transaction:
 *   Safe.execTransaction → Timelock.unpauseDiamond([]) → Diamond.unpauseDiamond([])
 * No schedule + wait + execute round-trip. The diamond is live again the instant
 * the Safe tx is mined.
 *
 * For each of sophon, boba, rootstock the script:
 *   1. Fetches the pending Safe proposal from MongoDB.
 *   2. Runs `publicClient.call({ account: safe, to: <stored to>, data: <stored data> })`
 *      against current chain state. `eth_call` follows the full call chain, so a
 *      revert at the Timelock's role check OR at the Diamond's owner check OR
 *      anywhere in the unpause logic surfaces as a failure.
 *   3. Reports success/revert per network.
 *
 * If this returns success on all three, the proposals will execute cleanly once
 * sigs are collected — no waiting required.
 *
 * Run: `bunx tsx ./script/tasks/temp/simulateUnpauseProposals.ts`
 */

import 'dotenv/config'

import { consola } from 'consola'
import { createPublicClient, http, type Address, type Hex } from 'viem'

import { EnvironmentEnum } from '../../common/types'
import {
  getPendingTransactionsByNetwork,
  getSafeMongoCollection,
} from '../../deploy/safe/safe-utils'
import { getDeployments } from '../../utils/deploymentHelpers'
import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

const NETWORKS = ['sophon', 'boba', 'rootstock'] as const

// Selector for unpauseDiamond(address[])
const UNPAUSE_SELECTOR = '0x2fc487ae' as const

async function main(): Promise<number> {
  consola.info('Simulating Phase 2b unpause proposals...')
  consola.info(`Networks: ${NETWORKS.join(', ')}`)

  const { client: mongoClient, pendingTransactions } =
    await getSafeMongoCollection()

  let succeeded = 0
  let failed = 0

  try {
    const txsByNetwork = await getPendingTransactionsByNetwork(
      pendingTransactions,
      [...NETWORKS]
    )

    for (const network of NETWORKS) {
      consola.start(`[${network}] simulating...`)
      try {
        const deployments = await getDeployments(
          network,
          EnvironmentEnum.production
        )
        const expectedTo = (
          deployments.LiFiTimelockController as string | undefined
        )?.toLowerCase()
        if (!expectedTo)
          throw new Error(
            `No LiFiTimelockController deployment found for ${network}`
          )

        const txs = txsByNetwork[network] ?? []
        const selectorMatches = txs.filter((t) =>
          t.safeTx.data.data.toLowerCase().startsWith(UNPAUSE_SELECTOR)
        )
        const staleMatches = selectorMatches.filter(
          (t) => t.safeTx.data.to.toLowerCase() !== expectedTo
        )
        if (staleMatches.length > 0)
          consola.warn(
            `[${network}] ignoring ${
              staleMatches.length
            } stale unpauseDiamond proposal(s) with wrong to: ${staleMatches
              .map((t) => `${t.safeTx.data.to} (nonce ${t.safeTx.data.nonce})`)
              .join(', ')}`
          )

        const unpauseTxs = selectorMatches.filter(
          (t) => t.safeTx.data.to.toLowerCase() === expectedTo
        )
        if (unpauseTxs.length === 0)
          throw new Error(
            `no pending unpauseDiamond proposal found targeting LiFiTimelockController (${expectedTo})`
          )
        if (unpauseTxs.length > 1)
          consola.warn(
            `[${network}] ${unpauseTxs.length} matching pending proposals — simulating the lowest-nonce one`
          )

        const tx = unpauseTxs[0]
        if (!tx) throw new Error('unreachable: filtered list empty after check')
        const safeAddress = tx.safeAddress as Address
        const to = tx.safeTx.data.to as Address
        const data = tx.safeTx.data.data as Hex

        const chain = getViemChainForNetworkName(network)
        const rpcUrl = chain.rpcUrls.default.http[0]
        const publicClient = createPublicClient({
          chain,
          transport: http(rpcUrl),
        })

        consola.info(`[${network}] Safe:    ${safeAddress}`)
        consola.info(`[${network}] To:      ${to}`)
        consola.info(`[${network}] Nonce:   ${tx.safeTx.data.nonce}`)
        consola.info(`[${network}] Data:    ${data}`)

        await publicClient.call({
          account: safeAddress,
          to,
          data,
          value: 0n,
        })

        consola.success(
          `[${network}] eth_call succeeded — unpause will execute when threshold is met`
        )
        succeeded++
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        consola.error(`[${network}] simulation FAILED: ${msg}`)
        failed++
      }
    }
  } finally {
    await mongoClient.close()
  }

  console.log('')
  consola.info(`Done. Succeeded: ${succeeded}, Failed: ${failed}`)
  return failed
}

main()
  .then((failed) => process.exit(failed > 0 ? 1 : 0))
  .catch((err) => {
    consola.error('Fatal error:', err)
    process.exit(1)
  })
