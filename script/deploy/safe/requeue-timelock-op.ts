#!/usr/bin/env bun

/**
 * Requeue Timelock Op
 *
 * Re-drives one row of the timelock auto-execution queue (`MONGODB_URI` cluster,
 * DB `timelock-operations`, collection `queue`) from `blocked` back to `queued`
 * so the runner picks it up on its next tick.
 *
 * This exists because a row the runner refuses is otherwise unreachable: the
 * executor only ever reads `status: 'queued'`, so before this script the only way
 * to recover a still-executable operation was to hand-edit production MongoDB
 * (EXSC-816).
 *
 * It does NOT bypass the pre-execute guard. Flipping the row back to `queued`
 * only makes the runner look at it again; if the condition that blocked it is
 * still true, the guard re-blocks it on the next run. Use this after clearing the
 * cause, not instead of clearing it.
 *
 * Exit codes: 0 requeued (or dry-run OK); 1 refused or real error; 2 recoverable
 * misconfig (`MONGODB_URI` missing or cluster unreachable). The cluster is the
 * non-sensitive one — no VPN required.
 *
 *   bunx tsx ./script/deploy/safe/requeue-timelock-op.ts \
 *     --network mode --operationId 0xc465… [--dryRun] [--force]
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { createPublicClient, http, parseAbi, type Hex } from 'viem'

import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

import {
  byOperationId,
  computeOperationIdBatch,
  deserializeScheduleParams,
  getTimelockQueueCollection,
  queueStatusReason,
  type ITimelockQueueDoc,
} from './timelock-queue'

const TIMELOCK_STATUS_ABI = parseAbi([
  'function isOperation(bytes32 id) view returns (bool)',
  'function isOperationPending(bytes32 id) view returns (bool)',
  'function isOperationReady(bytes32 id) view returns (bool)',
  'function isOperationDone(bytes32 id) view returns (bool)',
])

/** On-chain state of the operation, read fresh before any write. */
export interface IOnChainOpState {
  isOperation: boolean
  isPending: boolean
  isReady: boolean
  isDone: boolean
}

/** Outcome of the pre-write validation. */
export type RequeueVerdict =
  | { ok: true; warning?: string }
  | { ok: false; reason: string }

/**
 * Decides whether a queue row may be flipped back to `queued`.
 *
 * Pure, so every refusal path is testable without Mongo or an RPC. The checks
 * mirror the runner's own trust checks: a row whose stored `operationId` does not
 * match the id derived from its stored schedule params is refused outright — even
 * with `--force` — because re-driving a tampered row is the one thing this script
 * must never do.
 *
 * @param doc - The queue row.
 * @param derivedOperationId - Operation id recomputed from the row's own params.
 * @param onChain - Freshly-read on-chain state of the operation.
 * @param force - Whether the operator opted into re-driving a `failed` row.
 * @returns Whether to proceed, and why not when refusing.
 */
export function validateRequeue(
  doc: Pick<
    ITimelockQueueDoc,
    'status' | 'operationId' | 'blockedReason' | 'failureReason'
  >,
  derivedOperationId: Hex,
  onChain: IOnChainOpState,
  force: boolean
): RequeueVerdict {
  if (derivedOperationId.toLowerCase() !== doc.operationId.toLowerCase())
    return {
      ok: false,
      reason:
        `operationId mismatch (stored=${doc.operationId}, derived from stored params=${derivedOperationId}). ` +
        'The row does not describe the operation it claims to; refusing even with --force.',
    }

  if (doc.status === 'queued')
    return {
      ok: false,
      reason:
        'row is already queued — the runner will pick it up on its next tick; nothing to re-drive.',
    }
  if (doc.status === 'executed')
    return { ok: false, reason: 'row is already executed.' }
  if (doc.status === 'cancelled')
    return {
      ok: false,
      reason:
        'row is cancelled. A cancelled timelock op cannot be revived — re-propose it via the Safe.',
    }
  if (doc.status === 'failed' && !force)
    return {
      ok: false,
      reason:
        `row is 'failed', not 'blocked' — reserved for ops that can never run as stored (tampered row, on-chain revert): ` +
        `${queueStatusReason(doc) ?? 'no reason recorded'}. ` +
        'Re-read the reason first; pass --force only if you are certain it is re-drivable.',
    }

  if (!onChain.isOperation)
    return {
      ok: false,
      reason:
        'operation does not exist on the timelock controller — it was never scheduled, or the schedule tx reverted. ' +
        'The originating Safe tx must be re-executed; requeueing cannot help.',
    }
  if (onChain.isDone)
    return {
      ok: false,
      reason:
        'operation is already done on-chain. The runner reconciles this to `executed` on its next pass; do not requeue.',
    }
  if (!onChain.isPending)
    return {
      ok: false,
      reason:
        'operation exists but is not pending on-chain (cancelled on the controller). Re-propose it via the Safe.',
    }

  return onChain.isReady
    ? { ok: true }
    : {
        ok: true,
        warning:
          'operation is pending but its delay has not elapsed yet; the runner will hold it until it is ready.',
      }
}

/**
 * Classifies a Mongo connection failure so the CLI can exit 2 on recoverable
 * misconfiguration instead of conflating it with a refusal. Mirrors
 * `list-timelock-queue.ts`.
 */
function classifyMongoError(error: unknown): 'misconfig' | 'error' {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  if (message.includes('MONGODB_URI')) return 'misconfig'
  if (
    name === 'MongoServerSelectionError' ||
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/.test(message)
  )
    return 'misconfig'
  return 'error'
}

const cmd = defineCommand({
  meta: {
    name: 'requeue-timelock-op',
    description:
      'Re-validate a blocked timelock queue row on-chain and flip it back to queued',
  },
  args: {
    network: {
      type: 'string',
      description: 'Network the operation belongs to (e.g. "mode")',
      required: true,
    },
    operationId: {
      type: 'string',
      description: 'Timelock operation id (32-byte hex)',
      required: true,
    },
    dryRun: {
      type: 'boolean',
      description: 'Validate and report, but do not write to MongoDB',
      required: false,
      default: false,
    },
    force: {
      type: 'boolean',
      description:
        "Allow re-driving a 'failed' row (never bypasses the operationId or on-chain checks)",
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    const network = args.network.toLowerCase()
    const operationId = args.operationId as Hex

    if (!/^0x[0-9a-fA-F]{64}$/.test(operationId)) {
      consola.error(
        `Invalid --operationId "${operationId}": expected 32-byte hex (0x + 64 hex chars).`
      )
      process.exit(1)
    }

    let client
    let timelockQueue
    try {
      ;({ client, timelockQueue } = await getTimelockQueueCollection())
    } catch (error) {
      consola.error(
        `Could not connect to timelock queue MongoDB: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
      process.exit(classifyMongoError(error) === 'misconfig' ? 2 : 1)
    }

    try {
      const doc = await timelockQueue.findOne(
        byOperationId(network, operationId)
      )
      if (!doc) {
        consola.error(
          `No queue row for network "${network}" and operationId ${operationId}.`
        )
        process.exit(1)
      }

      consola.info(
        `[${network}] ${operationId} — status: ${doc.status}${
          queueStatusReason(doc) ? ` (${queueStatusReason(doc)})` : ''
        }`
      )

      const params = deserializeScheduleParams(doc)
      const derivedOperationId = computeOperationIdBatch(
        params.targets,
        params.values,
        params.payloads,
        params.predecessor,
        params.salt
      )

      const publicClient = createPublicClient({
        chain: getViemChainForNetworkName(network),
        transport: http(),
      })

      const read = (
        functionName:
          | 'isOperation'
          | 'isOperationPending'
          | 'isOperationReady'
          | 'isOperationDone'
      ) =>
        publicClient.readContract({
          address: doc.timelockAddress,
          abi: TIMELOCK_STATUS_ABI,
          functionName,
          args: [operationId],
        }) as Promise<boolean>

      const [isOperation, isPending, isReady, isDone] = await Promise.all([
        read('isOperation'),
        read('isOperationPending'),
        read('isOperationReady'),
        read('isOperationDone'),
      ])
      const onChain: IOnChainOpState = {
        isOperation,
        isPending,
        isReady,
        isDone,
      }
      consola.info(
        `[${network}] on-chain: isOperation=${isOperation}, isOperationPending=${isPending}, isOperationReady=${isReady}, isOperationDone=${isDone}`
      )

      const verdict = validateRequeue(
        doc,
        derivedOperationId,
        onChain,
        Boolean(args.force)
      )
      if (!verdict.ok) {
        consola.error(`Refusing to requeue: ${verdict.reason}`)
        process.exit(1)
      }
      if (verdict.warning) consola.warn(verdict.warning)

      if (args.dryRun) {
        consola.success(
          `[DRY RUN] Would flip ${operationId} on ${network} from '${doc.status}' to 'queued'.`
        )
        return
      }

      const now = new Date()
      await timelockQueue.updateOne(byOperationId(network, operationId), {
        $set: {
          status: 'queued',
          requeuedAt: now,
          updatedAt: now,
          requeueCount: (doc.requeueCount ?? 0) + 1,
        },
        $unset: {
          blockedReason: '',
          blockedAt: '',
          blockedAlertedAt: '',
          failureReason: '',
        },
      })

      consola.success(
        `Requeued ${operationId} on ${network} (was '${doc.status}'). ` +
          'The runner will re-run the pre-execute guard on its next tick — if the original cause is still present it will block again.'
      )
    } catch (error) {
      consola.error('Failed to requeue timelock op:', error)
      process.exit(classifyMongoError(error) === 'misconfig' ? 2 : 1)
    } finally {
      await client.close()
    }
  },
})

if (import.meta.main) runMain(cmd)
