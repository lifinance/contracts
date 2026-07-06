#!/usr/bin/env bun

/**
 * List Timelock Queue
 *
 * Read-only lister for the timelock auto-execution queue (`MONGODB_URI`
 * cluster, DB `timelock-operations`, collection `queue`). Used by the
 * `/finish-rollout` skill as its execution-verification gate and for ops
 * debugging ("what's queued for base?"). Never mutates rows.
 *
 * Exit codes: 0 success; 1 real error (bad args, Mongo query or on-chain
 * check failed); 2 recoverable misconfig (`MONGODB_URI` missing or cluster
 * unreachable). The cluster is the non-sensitive one — no VPN required.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { Filter } from 'mongodb'
import { createPublicClient, http, parseAbi } from 'viem'

import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

import {
  getTimelockQueueCollection,
  type ITimelockQueueDoc,
} from './timelock-queue'

const TIMELOCK_DONE_ABI = parseAbi([
  'function isOperationDone(bytes32 id) view returns (bool)',
])

const QUEUE_STATUSES = ['queued', 'executed', 'cancelled', 'failed'] as const

type QueueStatusArg = (typeof QUEUE_STATUSES)[number] | 'all'

/** Row shape printed by this CLI (JSON mode prints an array of these). */
export interface IQueueDisplayRow {
  network: string
  operationId: string
  status: string
  safeTxHash: string
  executionTxHash?: string
  createdAt: string
  executedAt?: string
  /** Present only with --checkOnChain; null when the RPC check failed. */
  onChainDone?: boolean | null
}

/**
 * Parses the --status argument (case-insensitive).
 *
 * @param raw - Raw CLI value.
 * @returns A known queue status or 'all' (the default).
 * @throws Error on unknown values.
 */
export function parseStatusArg(raw?: string): QueueStatusArg {
  if (!raw) return 'all'
  const status = raw.toLowerCase()
  if (
    status === 'all' ||
    (QUEUE_STATUSES as readonly string[]).includes(status)
  )
    return status as QueueStatusArg
  throw new Error(
    `Invalid --status "${raw}". Use one of: ${QUEUE_STATUSES.join(', ')}, all`
  )
}

/**
 * Splits a comma-separated CLI value into trimmed, lowercased entries.
 *
 * @param raw - Raw CLI value.
 * @returns Entries, or undefined when the input is missing/blank.
 */
export function parseCsvArg(raw?: string): string[] | undefined {
  if (!raw) return undefined
  const entries = raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
  return entries.length > 0 ? entries : undefined
}

/**
 * Builds the Mongo filter for the queue query. Values are wrapped in
 * $in/$eq so they can never be interpreted as operator expressions.
 *
 * @param networks - Lowercase network names, or undefined for all.
 * @param status - Status filter ('all' adds no constraint).
 * @returns Filter for the queue collection.
 */
export function buildQueueFilter(
  networks: string[] | undefined,
  status: QueueStatusArg
): Filter<ITimelockQueueDoc> {
  const filter: Filter<ITimelockQueueDoc> = {}
  if (networks) filter.network = { $in: networks }
  if (status !== 'all') filter.status = { $eq: status }
  return filter
}

/**
 * Case-insensitive in-memory filter by originating Safe tx hash. Done in JS
 * (not Mongo) because stored hash casing is not normalized.
 *
 * @param rows - Queue rows from Mongo.
 * @param safeTxHashes - Lowercased hashes to keep, or undefined for all.
 * @returns Matching rows.
 */
export function filterBySafeTxHashes(
  rows: ITimelockQueueDoc[],
  safeTxHashes: string[] | undefined
): ITimelockQueueDoc[] {
  if (!safeTxHashes) return rows
  return rows.filter((row) =>
    safeTxHashes.includes(row.safeTxHash.toLowerCase())
  )
}

/**
 * Keeps rows where any payload contains any of the given hex needles
 * (case-insensitive, leading 0x optional). Used to correlate queue rows with
 * a rollout by the deployed contract address embedded in the scheduled call.
 *
 * @param rows - Queue rows from Mongo.
 * @param needles - Hex fragments to search for, or undefined for all rows.
 * @returns Matching rows.
 */
export function filterByPayloadContains(
  rows: ITimelockQueueDoc[],
  needles: string[] | undefined
): ITimelockQueueDoc[] {
  if (!needles) return rows
  const normalized = needles.map((needle) =>
    needle.toLowerCase().replace(/^0x/, '')
  )
  return rows.filter((row) =>
    row.payloads.some((payload) => {
      const haystack = payload.toLowerCase()
      return normalized.some((needle) => haystack.includes(needle))
    })
  )
}

/**
 * Classifies a Mongo connection/query error for exit-code mapping.
 *
 * @param error - The thrown value.
 * @returns 'misconfig' (exit 2: missing env var or unreachable cluster) or 'error' (exit 1).
 */
export function classifyMongoError(error: unknown): 'misconfig' | 'error' {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  if (message.includes('MONGODB_URI')) return 'misconfig'
  // Server-selection / socket-level failures are how an unreachable cluster
  // presents (bad URI, network trouble).
  if (
    name === 'MongoServerSelectionError' ||
    /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/.test(message)
  )
    return 'misconfig'
  return 'error'
}

/**
 * Maps a queue doc to the printable row shape.
 *
 * @param doc - Queue row from Mongo.
 * @param onChainDone - isOperationDone result (undefined when not checked, null when the check failed).
 * @returns Display row with ISO-string dates.
 */
export function toDisplayRow(
  doc: ITimelockQueueDoc,
  onChainDone?: boolean | null
): IQueueDisplayRow {
  const row: IQueueDisplayRow = {
    network: doc.network,
    operationId: doc.operationId,
    status: doc.status,
    safeTxHash: doc.safeTxHash,
    createdAt: doc.createdAt.toISOString(),
  }
  if (doc.executionTxHash) row.executionTxHash = doc.executionTxHash
  if (doc.executedAt) row.executedAt = doc.executedAt.toISOString()
  if (onChainDone !== undefined) row.onChainDone = onChainDone
  return row
}

/**
 * Reads isOperationDone for every row, grouped per network (one client per
 * network; rows sequential within a network to stay under RPC rate caps).
 *
 * @param rows - Queue rows to check.
 * @returns operationId->done map (null where the check failed) and error count.
 */
async function checkOnChainDone(
  rows: ITimelockQueueDoc[]
): Promise<{ doneById: Map<string, boolean | null>; errorCount: number }> {
  const doneById = new Map<string, boolean | null>()
  let errorCount = 0
  const byNetwork = new Map<string, ITimelockQueueDoc[]>()
  for (const row of rows) {
    const group = byNetwork.get(row.network) ?? []
    group.push(row)
    byNetwork.set(row.network, group)
  }
  await Promise.all(
    [...byNetwork.entries()].map(async ([network, networkRows]) => {
      let publicClient
      try {
        publicClient = createPublicClient({
          chain: getViemChainForNetworkName(network),
          transport: http(),
        })
      } catch (error) {
        consola.error(`[${network}] Could not create RPC client:`, error)
        errorCount += networkRows.length
        for (const row of networkRows) doneById.set(row.operationId, null)
        return
      }
      for (const row of networkRows)
        try {
          const done = await publicClient.readContract({
            address: row.timelockAddress,
            abi: TIMELOCK_DONE_ABI,
            functionName: 'isOperationDone',
            args: [row.operationId],
          })
          doneById.set(row.operationId, done)
        } catch (error) {
          errorCount++
          doneById.set(row.operationId, null)
          consola.error(
            `[${network}] isOperationDone check failed for ${row.operationId}:`,
            error
          )
        }
    })
  )
  return { doneById, errorCount }
}

const cmd = defineCommand({
  meta: {
    name: 'list-timelock-queue',
    description:
      'List timelock auto-execution queue rows (read-only; optional on-chain isOperationDone cross-check)',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Only show rows for these networks (comma-separated, e.g. "arbitrum,base")',
      required: false,
    },
    safeTxHash: {
      type: 'string',
      description:
        'Only show rows originating from these Safe tx hashes (comma-separated, case-insensitive)',
      required: false,
    },
    payloadContains: {
      type: 'string',
      description:
        'Only show rows where a payload contains one of these hex fragments, e.g. deployed contract addresses (comma-separated, 0x optional)',
      required: false,
    },
    status: {
      type: 'string',
      description:
        'Filter by status: queued|executed|cancelled|failed|all (default all)',
      required: false,
    },
    checkOnChain: {
      type: 'boolean',
      description:
        "Cross-check isOperationDone on each row's timelock controller",
      required: false,
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Machine-readable JSON output',
      required: false,
      default: false,
    },
  },
  async run({ args }) {
    // JSON consumers parse stdout; suppress info/success but keep errors visible
    if (args.json) consola.level = 0

    let status: QueueStatusArg
    let networks: string[] | undefined
    let safeTxHashes: string[] | undefined
    let payloadNeedles: string[] | undefined
    try {
      status = parseStatusArg(args.status)
      networks = parseCsvArg(args.network)
      safeTxHashes = parseCsvArg(args.safeTxHash)
      payloadNeedles = parseCsvArg(args.payloadContains)
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error))
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

    let rows: ITimelockQueueDoc[]
    try {
      rows = await timelockQueue
        .find(buildQueueFilter(networks, status))
        .toArray()
    } catch (error) {
      consola.error('Failed to query timelock queue:', error)
      await client.close()
      process.exit(classifyMongoError(error) === 'misconfig' ? 2 : 1)
    }
    await client.close()

    rows = filterByPayloadContains(
      filterBySafeTxHashes(rows, safeTxHashes),
      payloadNeedles
    )

    let doneById = new Map<string, boolean | null>()
    let onChainErrors = 0
    if (args.checkOnChain && rows.length > 0)
      ({ doneById, errorCount: onChainErrors } = await checkOnChainDone(rows))

    const displayRows = rows.map((row) =>
      toDisplayRow(
        row,
        args.checkOnChain ? doneById.get(row.operationId) ?? null : undefined
      )
    )

    if (args.json) console.log(JSON.stringify(displayRows, null, 2))
    else if (displayRows.length === 0) consola.info('No matching queue rows.')
    else
      for (const row of displayRows) {
        consola.info(
          `[${row.network}] ${row.operationId} — ${row.status}` +
            (row.onChainDone === undefined
              ? ''
              : ` (on-chain done: ${
                  row.onChainDone === null ? 'CHECK FAILED' : row.onChainDone
                })`)
        )
        consola.info(`   safeTxHash: ${row.safeTxHash}`)
        if (row.executionTxHash)
          consola.info(`   executionTxHash: ${row.executionTxHash}`)
        consola.info(
          `   createdAt: ${row.createdAt}` +
            (row.executedAt ? ` — executedAt: ${row.executedAt}` : '')
        )
      }

    if (onChainErrors > 0) {
      consola.error(`${onChainErrors} on-chain check(s) failed`)
      process.exit(1)
    }
  },
})

if (import.meta.main) runMain(cmd)
