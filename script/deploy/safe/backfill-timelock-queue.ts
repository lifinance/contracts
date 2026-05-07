#!/usr/bin/env bun

/**
 * One-shot backfill of the timelock execution queue at cutover.
 *
 * Reads eligible rows from `SC_MONGODB_URI.sc_private.pendingTransactions`
 * (Safe txs with `scheduleBatch` calldata that have been mined on-chain but
 * the timelock op has not yet been executed) and upserts them into
 * `MONGODB_URI.timelock-operations.queue` so the auto-execution runner can
 * pick them up without the legacy DB.
 *
 * Run once on VPN by an operator immediately before / at cutover.
 * The script is idempotent (unique index on `operationId`) and safe to re-run.
 *
 * Delete this script once cutover is verified.
 *
 *   bunx tsx ./script/deploy/safe/backfill-timelock-queue.ts [--dryRun]
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import data from '../../../config/networks.json'
import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'

import { getSafeMongoCollection, type ISafeTxDocument } from './safe-utils'
import { TIMELOCK_SCHEDULE_BATCH_SELECTOR } from './timelock-abi'
import {
  byOperationId,
  computeOperationIdBatch,
  decodeScheduleBatch,
  getTimelockQueueCollection,
  serializeScheduleParams,
} from './timelock-queue'

interface INetworkConfig {
  name: string
  chainId: number
  status: string
}

interface IDeploymentData {
  LiFiTimelockController?: string
  [key: string]: string | undefined
}

interface INetworkResult {
  network: string
  scanned: number
  enqueued: number
  skipped: number
  failed: number
}

const cmd = defineCommand({
  meta: {
    name: 'backfill-timelock-queue',
    description:
      'Copy in-flight timelock ops from SC_MONGODB_URI.pendingTransactions to MONGODB_URI.timelock-operations.queue',
  },
  args: {
    dryRun: {
      type: 'boolean',
      description: 'Scan and report without writing the queue',
      required: false,
      default: false,
    },
    network: {
      type: 'string',
      description: 'Optional single network to backfill',
      required: false,
    },
  },
  async run({ args }) {
    const isDryRun = Boolean(args?.dryRun)
    const networksConfig = data as Record<string, INetworkConfig>
    const networksToProcess: INetworkConfig[] = args?.network
      ? [networksConfig[args.network.toLowerCase()] as INetworkConfig].filter(
          Boolean
        )
      : Object.values(networksConfig).filter((n) => n.status === 'active')

    if (networksToProcess.length === 0) {
      consola.error('No networks to process')
      process.exit(1)
    }

    consola.info(
      `🔁 Backfilling${isDryRun ? ' (dry run)' : ''} for ${
        networksToProcess.length
      } network(s)`
    )

    const { client: safeClient, pendingTransactions } =
      await getSafeMongoCollection()
    const { client: queueClient, timelockQueue } =
      await getTimelockQueueCollection()

    const results: INetworkResult[] = []
    try {
      const batchSelectorRegex =
        TIMELOCK_SCHEDULE_BATCH_SELECTOR.slice(2).toLowerCase()

      for (const network of networksToProcess) {
        const result: INetworkResult = {
          network: network.name,
          scanned: 0,
          enqueued: 0,
          skipped: 0,
          failed: 0,
        }

        let timelockAddress: string | undefined
        try {
          const deployments = (await getDeployments(
            network.name as SupportedChain,
            EnvironmentEnum.production
          )) as IDeploymentData
          timelockAddress = deployments.LiFiTimelockController
        } catch (error) {
          consola.warn(
            `[${network.name}] Could not load deployments; skipping:`,
            error
          )
          results.push(result)
          continue
        }

        if (!timelockAddress) {
          consola.info(
            `[${network.name}] No LiFiTimelockController deployment; skipping`
          )
          results.push(result)
          continue
        }

        // Match the legacy executor filter so we backfill exactly the rows
        // the old runner would have picked up.
        const txs: ISafeTxDocument[] = await pendingTransactions
          .find({
            network: network.name.toLowerCase(),
            'safeTx.data.data': { $regex: `^0x${batchSelectorRegex}` },
            status: 'executed',
            // Field has been removed from the new flow but lingers on legacy docs.
            timelockIsExecuted: { $ne: true },
          } as Record<string, unknown>)
          .toArray()

        result.scanned = txs.length

        for (const tx of txs)
          try {
            const callData = tx.safeTx?.data?.data
            if (!callData) {
              result.skipped++
              continue
            }
            const params = decodeScheduleBatch(callData)
            const operationId = computeOperationIdBatch(
              params.targets,
              params.values,
              params.payloads,
              params.predecessor,
              params.salt
            )

            if (isDryRun) {
              consola.info(
                `[${network.name}] would enqueue ${operationId} (safeTxHash=${tx.safeTxHash})`
              )
              result.enqueued++
              continue
            }

            const now = new Date()
            await timelockQueue.updateOne(
              byOperationId(operationId),
              {
                $setOnInsert: {
                  operationId,
                  network: network.name.toLowerCase(),
                  chainId: network.chainId,
                  timelockAddress: normalizeAddressForNetwork(
                    network.name,
                    timelockAddress
                  ),
                  ...serializeScheduleParams(params),
                  createdAt: now,
                },
                $set: {
                  status: 'queued',
                  safeTxHash: tx.safeTxHash,
                  // executionHash may be missing on older legacy docs.
                  ...((tx as { executionHash?: string }).executionHash
                    ? {
                        executionHash: (tx as { executionHash?: string })
                          .executionHash,
                      }
                    : {}),
                  updatedAt: now,
                },
              },
              { upsert: true }
            )
            result.enqueued++
          } catch (error) {
            result.failed++
            consola.error(
              `[${network.name}] Failed to backfill safeTxHash=${tx.safeTxHash}:`,
              error
            )
          }

        consola.info(
          `[${network.name}] scanned=${result.scanned} enqueued=${result.enqueued} skipped=${result.skipped} failed=${result.failed}`
        )
        results.push(result)
      }
    } finally {
      await safeClient.close()
      await queueClient.close()
    }

    const totals = results.reduce(
      (acc, r) => ({
        scanned: acc.scanned + r.scanned,
        enqueued: acc.enqueued + r.enqueued,
        skipped: acc.skipped + r.skipped,
        failed: acc.failed + r.failed,
      }),
      { scanned: 0, enqueued: 0, skipped: 0, failed: 0 }
    )

    consola.info(
      `\n📊 Backfill summary: scanned=${totals.scanned} enqueued=${totals.enqueued} skipped=${totals.skipped} failed=${totals.failed}`
    )

    if (totals.failed > 0) {
      consola.error('Backfill completed with failures')
      process.exit(1)
    }
    consola.success('Backfill complete')
  },
})

runMain(cmd)
