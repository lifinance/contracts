#!/usr/bin/env bun

/**
 * Report-only timelock watcher: finds every pending operation on every
 * production `LiFiTimelockController` from its logs, re-checks it, and alerts
 * Slack on a mismatch or a new unverified finding.
 *
 * Run by `.github/workflows/timelockWatcher.yml`; runnable locally for a dry run
 * (Slack is only posted from CI). It never cancels, executes or signs anything.
 *
 *   bunx tsx ./script/deploy/safe/timelock-watcher.ts [--network <name>] [--stateFile <path>]
 */

import 'dotenv/config'

import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { MongoClient } from 'mongodb'
import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  parseAbi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from 'viem'

import globalConfig from '../../../config/global.json'
import networksConfig from '../../../config/networks.json'
import timelockConfig from '../../../config/timelockController.json'
import type { INetworksObject } from '../../common/types'
import { sleep } from '../../utils/delay'
import { isEntrypoint } from '../../utils/is-entrypoint'
import { redactUrls } from '../../utils/redactUrls'
import { SlackNotifier, isUnattendedRun } from '../../utils/slack-notifier'
import {
  getFallbackTransportForChain,
  getTransportConfigFromRpcUrl,
  getViemChainForNetworkName,
} from '../../utils/viemScriptHelpers'
import {
  verifyCutTargets,
  type IGateReport,
} from '../codehash/verify-cut-targets'
import { ZERO_ADDRESS } from '../shared/constants'

import {
  createSignTimeCodehashDeps,
  type ISignTimeCodehashDeps,
} from './codehash-sign-gate-deps'
import { createPinnedBlobReader } from './pinned-target-state'
import {
  runPreBroadcastGate,
  viemGateReaders,
  viemScheduledAtReader,
} from './prebroadcast-gate'
import { collectDiamondCutTargets } from './safe-decode-utils'
import {
  SIGNED_SET_COLLECTION_NAME,
  SIGNED_SET_DB_NAME,
  byOperationKey,
} from './signed-set-record'
import { TIMELOCK_SCHEDULE_BATCH_ABI } from './timelock-abi'
import {
  evaluateCancelDecision,
  renderCancelDecision,
} from './timelock-cancel-decision'
import { resolveTimelockSkipReason } from './timelock-prefetch'
import {
  TIMELOCK_QUEUE_COLLECTION_NAME,
  TIMELOCK_QUEUE_DB_NAME,
  type ITimelockQueueDoc,
} from './timelock-queue'
import {
  decideAlerts,
  findingKey,
  type IAlertRecord,
  type IWatchFinding,
} from './timelock-watcher-alerts'
import {
  renderJobSummary,
  renderSlackAlert,
  tallyReports,
  type INetworkReport,
  type IOperationReport,
} from './timelock-watcher-report'
import {
  CALL_SALT_EVENT,
  CALL_SCHEDULED_EVENT,
  CANCELLED_EVENT,
  advanceScan,
  bisectCreationBlock,
  initialScanState,
  isProvenCancelled,
  recomputeOperationIds,
  type INetworkScanState,
  type IScannedOperation,
} from './timelock-watcher-scan'
import {
  buildWatcherCancelInput,
  classifyOperation,
  gradeAuthorities,
  gradeAuthority,
  gradeCodehash,
  gradeDelay,
  gradeDelegatecall,
  gradeIdentity,
  gradeState,
  gradeTargets,
  installedAddresses,
  installsCode,
  stageOf,
  type ICheckOutcome,
  type TCodehashResult,
  type TOperationStage,
  type TWatcherVerdict,
} from './timelock-watcher-verdict'

const TIMELOCK_READ_ABI = parseAbi([
  'function getTimestamp(bytes32 id) view returns (uint256)',
  'function getMinDelay() view returns (uint256)',
])
const OWNER_ABI = parseAbi(['function owner() view returns (address)'])

const STATE_VERSION = 1

// Defaults live here rather than in citty: a multi-word arg with a citty default
// drops a value passed under its kebab-case spelling.
const DEFAULT_STATE_FILE = 'timelock-watcher-state.json'

/** `eth_getLogs` calls a network's history backfill may spend per run. */
const DEFAULT_HISTORY_BUDGET = 2000

/** Gate K rebuilds per run; each can take minutes. */
const DEFAULT_CODEHASH_BUDGET = 3

/** Networks processed at once. */
const NETWORK_CONCURRENCY = 12

/** One RPC read; an endpoint that hangs must not hold the run. */
const RPC_CALL_TIMEOUT_MS = 20_000 // 20 seconds

/** Minutes a network's history backfill may take per run, so a scheduled run fits its cron interval. */
const DEFAULT_HISTORY_MINUTES = 2

/** History ranges read at once per network; the endpoints are slow per call, not per block. */
const HISTORY_PARALLEL_RANGES = 8

/** Time one network may take beyond its history budget before it counts as unreadable. */
const NETWORK_OVERHEAD_MS = 6 * 60 * 1000 // 6 minutes

/**
 * Runs in a row an operation with no `Cancelled` log may read as never
 * scheduled before it is dropped, so one lagging node cannot erase it.
 */
const UNSET_READS_BEFORE_DROP = 3

/** An unverifiable gate K result is retried once a day, not every run: each retry is a rebuild. */
const CODEHASH_UNKNOWN_RETRY_MS = 24 * 60 * 60 * 1000 // 24 hours

/** One operation's gate K rebuilds; the queue moves on without it after this. */
const REBUILD_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes

/** A cached gate K result, reused while the code it judged is unchanged. */
interface ICodehashCacheEntry {
  status: 'pass' | 'fail' | 'unknown'
  detail: string
  /** ISO time of the rebuild, to retry an unverifiable result once it is old. */
  checkedAt?: string
  /** keccak256 of the live code at each judged address. */
  codeHashes: Record<string, string>
}

export interface IWatcherState {
  version: number
  networks: Record<string, INetworkScanState>
  alerts: Record<string, IAlertRecord>
  codehash: Record<string, ICodehashCacheEntry>
}

const emptyState = (): IWatcherState => ({
  version: STATE_VERSION,
  networks: {},
  alerts: {},
  codehash: {},
})

/**
 * Loads the state an earlier run saved. A missing or unreadable file starts
 * afresh, which re-scans history and re-sends standing alerts: both fail loud.
 *
 * @param path - State file.
 * @returns The state.
 */
export const loadWatcherState = async (
  path: string
): Promise<IWatcherState> => {
  if (!existsSync(path)) return emptyState()
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as IWatcherState
    if (parsed.version !== STATE_VERSION) return emptyState()
    return {
      version: STATE_VERSION,
      networks: parsed.networks ?? {},
      alerts: parsed.alerts ?? {},
      codehash: parsed.codehash ?? {},
    }
  } catch (error) {
    consola.warn(
      `State file ${path} is unreadable; starting afresh: ${String(error)}`
    )
    return emptyState()
  }
}

/**
 * Rejects when `promise` has not settled within `ms`. The underlying request is
 * not aborted; the caller moves on without it.
 */
const withTimeout = async <T>(
  promise: Promise<T>,
  ms: number,
  what: string
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${what} timed out after ${ms / 1000}s`)),
          ms
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The same client, with every call it makes bounded by {@link RPC_CALL_TIMEOUT_MS}.
 * Covers the pre-broadcast gate's readers too, which take the client as given.
 */
const timeboxed = (client: PublicClient): PublicClient =>
  new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]): unknown => {
        const result: unknown = Reflect.apply(value, target, args)
        return result instanceof Promise
          ? withTimeout(result, RPC_CALL_TIMEOUT_MS, String(property))
          : result
      }
    },
  })

const describe = (error: unknown): string =>
  redactUrls(error instanceof Error ? error.message : String(error))
    .split('\n')[0]
    ?.slice(0, 300) ?? 'unknown error'

/** Runs `worker` over `items` with at most `limit` in flight. */
const mapPooled = async <T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length)
  let next = 0
  const lanes = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const at = next++
        results[at] = await worker(items[at] as T)
      }
    }
  )
  await Promise.all(lanes)
  return results
}

/**
 * One client per endpoint, for `eth_getLogs` only. An endpoint that refuses a
 * range is not retried behind the fallback transport's back-off on every call:
 * the scan moves to the endpoint that last answered and stays there.
 */
const createLogReaders = (chain: Chain): PublicClient[] =>
  chain.rpcUrls.default.http.flatMap((rpcUrl) => {
    try {
      const config = getTransportConfigFromRpcUrl(rpcUrl)
      return [
        timeboxed(
          createPublicClient({
            chain,
            transport: http(config.url, {
              ...(config.fetchOptions
                ? { fetchOptions: config.fetchOptions }
                : {}),
              retryCount: 1,
            }),
          }) as PublicClient
        ),
      ]
    } catch {
      return []
    }
  })

const readTimelockLogs = (
  reader: PublicClient,
  timelock: Address,
  fromBlock: bigint,
  toBlock: bigint
) =>
  reader.getLogs({
    address: timelock,
    events: [CALL_SCHEDULED_EVENT, CALL_SALT_EVENT, CANCELLED_EVENT],
    fromBlock,
    toBlock,
    strict: true,
  })

/** Queue rows per network, as a cross-check on the log scan. */
type TQueueIndex = Map<string, Set<string>> | { error: string }

/** Reads, never writes: the shared openers also create indexes. */
interface IWatcherStore {
  queue: TQueueIndex
  signedSetExists: (network: string, operationId: string) => Promise<boolean>
  close: () => Promise<void>
}

const openWatcherStore = async (): Promise<IWatcherStore> => {
  const uri = process.env.MONGODB_URI
  if (!uri) {
    const error = 'MONGODB_URI is not set'
    return {
      queue: { error },
      signedSetExists: async () => {
        throw new Error(error)
      },
      close: async () => undefined,
    }
  }
  const client = new MongoClient(uri)
  const db = client.db(TIMELOCK_QUEUE_DB_NAME)
  const signedSets = client
    .db(SIGNED_SET_DB_NAME)
    .collection(SIGNED_SET_COLLECTION_NAME)
  let queue: TQueueIndex
  try {
    const rows = await db
      .collection<ITimelockQueueDoc>(TIMELOCK_QUEUE_COLLECTION_NAME)
      .find(
        { status: { $in: ['queued', 'blocked'] } },
        { projection: { network: 1, operationId: 1 } }
      )
      .toArray()
    const index = new Map<string, Set<string>>()
    for (const row of rows) {
      const set = index.get(row.network) ?? new Set<string>()
      set.add(row.operationId.toLowerCase())
      index.set(row.network, set)
    }
    queue = index
  } catch (error) {
    queue = { error: describe(error) }
  }
  return {
    queue,
    signedSetExists: async (network, operationId) =>
      (await signedSets.countDocuments(byOperationKey(network, operationId), {
        limit: 1,
      })) > 0,
    close: () => client.close().catch(() => undefined),
  }
}

interface IRunContext {
  state: IWatcherState
  queue: TQueueIndex
  signedSetExists: IWatcherStore['signedSetExists']
  historyBudget: number
  historyMs: number
  codehash: {
    budget: { left: number }
    deps: () => ISignTimeCodehashDeps
    running?: Promise<void>
  }
  readPinned: ReturnType<typeof createPinnedBlobReader>
  expired: Set<string>
}

const encodeOperation = (op: IScannedOperation): Hex =>
  encodeFunctionData({
    abi: TIMELOCK_SCHEDULE_BATCH_ABI,
    functionName: 'scheduleBatch',
    args: [
      op.calls.map((c) => c.target),
      op.calls.map((c) => BigInt(c.value)),
      op.calls.map((c) => c.data),
      op.predecessor,
      op.salt,
      BigInt(op.delay),
    ],
  })

/**
 * Runs gate K over the code an operation wires in, reusing a cached result
 * while the live code at every judged address is unchanged.
 */
const runCodehash = async (
  network: string,
  op: IScannedOperation,
  client: PublicClient,
  ctx: IRunContext,
  isZkEVM: boolean
): Promise<TCodehashResult> => {
  const collected = collectDiamondCutTargets(encodeOperation(op))
  if (!installsCode(collected)) return { kind: 'not-applicable', collected }

  const judged = [
    ...collected.calls.flatMap((c) => [
      ...c.cuts.map((cut) => cut.facetAddress),
      c.init,
    ]),
    ...collected.registrations.map((r) => r.address),
  ].filter((a) => a.toLowerCase() !== ZERO_ADDRESS)

  const codeHashes: Record<string, string> = {}
  try {
    for (const address of judged)
      codeHashes[address.toLowerCase()] = keccak256(
        (await client.getCode({ address: address as Address })) ?? '0x'
      )
  } catch (error) {
    return {
      kind: 'error',
      reason: `the code at the operation's targets could not be read: ${describe(
        error
      )}`,
    }
  }

  const key = findingKey(network, op.id)
  const cached = ctx.state.codehash[key]
  const retryDue =
    cached?.status === 'unknown' &&
    !(
      Date.now() - Date.parse(cached.checkedAt ?? '') <
      CODEHASH_UNKNOWN_RETRY_MS
    )
  if (
    cached &&
    !retryDue &&
    JSON.stringify(cached.codeHashes) === JSON.stringify(codeHashes)
  )
    return { kind: 'cached', status: cached.status, detail: cached.detail }

  if (isZkEVM)
    return {
      kind: 'error',
      reason:
        'gate K cannot rebuild zkEVM code in this job (no foundry-zksync), so the code this operation installs is not verified',
    }

  const installations = [
    ...collected.calls,
    ...(collected.registrations.length > 0
      ? [
          {
            cuts: [],
            init: ZERO_ADDRESS,
            registrations: collected.registrations.map((r) => r.address),
          },
        ]
      : []),
  ]
  if (installations.length === 0)
    return { kind: 'evaluated', collected, reports: [] }

  if (ctx.codehash.budget.left <= 0)
    return {
      kind: 'deferred',
      reason:
        'gate K is queued behind this run’s rebuild budget and will run on a later run',
    }

  // One at a time, a timed-out one included: every rebuild shares one checkout
  // root keyed by commit, and a timeout does not stop the build. A network that
  // cannot get the slot defers rather than waiting out its own timeout.
  const waitUntil = Date.now() + REBUILD_TIMEOUT_MS
  while (ctx.codehash.running) {
    if (Date.now() >= waitUntil)
      return {
        kind: 'deferred',
        reason:
          'another gate K rebuild is still running; this one runs on a later run',
      }
    await Promise.race([
      ctx.codehash.running.catch(() => undefined),
      sleep(1000),
    ])
  }
  ctx.codehash.budget.left--

  const reports: IGateReport[] = []
  const rebuild = (async () => {
    for (const call of installations)
      reports.push(
        await verifyCutTargets(
          {
            cuts: call.cuts,
            init: call.init,
            network,
            ...('registrations' in call
              ? { registrations: call.registrations }
              : {}),
          },
          ctx.codehash.deps()
        )
      )
  })()
  ctx.codehash.running = rebuild
  void rebuild
    .catch(() => undefined)
    .finally(() => {
      if (ctx.codehash.running === rebuild) ctx.codehash.running = undefined
    })
  try {
    await withTimeout(rebuild, REBUILD_TIMEOUT_MS, 'gate K rebuild')
  } catch (error) {
    const reason = `gate K could not be evaluated: ${describe(error)}`
    // Cached like an unverifiable result, so a rebuild that always overruns is
    // retried daily rather than spending the budget every run.
    ctx.state.codehash[key] = {
      status: 'unknown',
      detail: reason,
      codeHashes,
      checkedAt: new Date().toISOString(),
    }
    return { kind: 'error', reason }
  }

  const result: TCodehashResult = { kind: 'evaluated', collected, reports }
  const graded = gradeCodehash(result)
  if (graded.status === 'skip') delete ctx.state.codehash[key]
  else
    ctx.state.codehash[key] = {
      status: graded.status,
      detail: graded.detail,
      codeHashes,
      checkedAt: new Date().toISOString(),
    }
  return result
}

const knownAddresses = (
  deployments: Record<string, unknown>,
  safe: string | undefined,
  timelock: string
): Map<string, string> => {
  const known = new Map<string, string>()
  for (const [name, value] of Object.entries(deployments))
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value))
      known.set(value.toLowerCase(), name)
  if (safe) known.set(safe.toLowerCase(), 'Safe')
  known.set(timelock.toLowerCase(), 'LiFiTimelockController')
  return known
}

const networkVerdict = (
  report: Omit<INetworkReport, 'verdict'>,
  flags: { mismatch: boolean; unverified: boolean }
): TWatcherVerdict =>
  flags.mismatch
    ? 'mismatch'
    : flags.unverified ||
      report.status === 'unreadable' ||
      report.status === 'uncovered'
    ? 'unverified'
    : 'ok'

/**
 * Watches one network.
 *
 * @returns Its report. The scan state is written into `ctx.state` only when the
 *   network was read; an unreadable network keeps what the last run saved.
 */
export const watchNetwork = async (
  network: INetworksObject[string],
  ctx: IRunContext
): Promise<INetworkReport> => {
  const name = network.name
  const startedAt = Date.now()
  const unreadable = (reason: string, timelock?: string): INetworkReport => ({
    network: name,
    status: 'unreadable',
    reason,
    ...(timelock ? { timelock } : {}),
    verdict: 'unverified',
    operations: [],
    notes: [],
  })

  let skip: Awaited<ReturnType<typeof resolveTimelockSkipReason>>
  try {
    skip = await resolveTimelockSkipReason(network)
  } catch (error) {
    return unreadable(
      `the deployments file could not be read: ${describe(error)}`
    )
  }
  if (skip)
    return {
      network: name,
      status: 'skipped',
      reason: skip,
      verdict: 'ok',
      operations: [],
      notes: [],
    }

  const pinned = ctx.readPinned(`deployments/${name}.json`)
  if (!pinned.ok)
    return unreadable(
      `main's deployments/${name}.json could not be read (${pinned.reason})`
    )
  const deployments = pinned.value
  const timelock = deployments['LiFiTimelockController'] as Address | undefined
  const diamond = deployments['LiFiDiamond'] as Address | undefined
  if (!timelock)
    return unreadable(`main's deployments/${name}.json names no timelock`)

  if (isTronNetworkKey(name))
    return {
      network: name,
      status: 'uncovered',
      timelock,
      reason:
        'Tron is not covered: the watcher reads EVM logs only, and the pre-broadcast gate treats Tron as uncovered-tron',
      verdict: 'unverified',
      operations: [],
      notes: [],
    }

  let client: PublicClient
  let logReaders: PublicClient[]
  try {
    const chain = getViemChainForNetworkName(name)
    logReaders = createLogReaders(chain)
    if (logReaders.length === 0)
      throw new Error('no RPC endpoint can serve eth_getLogs')
    client = timeboxed(
      createPublicClient({
        chain,
        transport: getFallbackTransportForChain(chain),
      }) as PublicClient
    )
  } catch (error) {
    return unreadable(describe(error), timelock)
  }

  const notes: string[] = []
  let flagMismatch = false
  let flagUnverified = false

  if (diamond)
    try {
      const owner = await client.readContract({
        address: diamond,
        abi: OWNER_ABI,
        functionName: 'owner',
      })
      if (owner.toLowerCase() !== timelock.toLowerCase()) {
        flagMismatch = true
        notes.push(
          `LiFiDiamond is owned by ${owner}, not by the timelock main names; operations on that owner are not watched`
        )
      }
    } catch (error) {
      return unreadable(
        `LiFiDiamond.owner() could not be read: ${describe(error)}`,
        timelock
      )
    }
  else {
    flagUnverified = true
    notes.push(
      `main's deployments/${name}.json names no LiFiDiamond, so the timelock is not checked against the diamond's owner`
    )
  }

  const previous = initialScanState(ctx.state.networks[name], timelock)
  let preferredReader = 0
  // An endpoint that answers eth_getLogs only up to its own head, without an
  // error, would let the scan record blocks it never saw as covered.
  const readerHeads = new Map<number, bigint>()
  let scan: Awaited<ReturnType<typeof advanceScan>>
  let floorNote: string | undefined
  try {
    scan = await advanceScan(
      previous,
      {
        head: () => client.getBlockNumber(),
        floor: async () => {
          const head = await client.getBlockNumber()
          try {
            return await bisectCreationBlock(head, async (blockNumber) => {
              const code = await withTimeout(
                client.getCode({ address: timelock, blockNumber }),
                RPC_CALL_TIMEOUT_MS,
                `getCode at block ${blockNumber}`
              )
              return code !== undefined && code !== '0x'
            })
          } catch (error) {
            floorNote = `creation block unknown (${describe(
              error
            )}); history is scanned from genesis`
            return 0n
          }
        },
        getLogs: async (fromBlock, toBlock) => {
          let logs: Awaited<ReturnType<typeof readTimelockLogs>> | undefined
          let lastError: unknown
          for (let k = 0; k < logReaders.length && !logs; k++) {
            const at = (preferredReader + k) % logReaders.length
            const reader = logReaders[at] as PublicClient
            try {
              let readerHead = readerHeads.get(at)
              if (readerHead === undefined || readerHead < toBlock) {
                readerHead = await reader.getBlockNumber()
                readerHeads.set(at, readerHead)
              }
              if (readerHead < toBlock)
                throw new Error(
                  `the endpoint is at block ${readerHead}, behind ${toBlock}`
                )
              logs = await readTimelockLogs(
                reader,
                timelock,
                fromBlock,
                toBlock
              )
              preferredReader = at
            } catch (error) {
              lastError = error
            }
          }
          if (!logs) throw lastError
          const scheduled = []
          const salts = []
          const cancels = []
          for (const log of logs)
            if (log.eventName === 'Cancelled')
              cancels.push({ id: log.args.id, blockNumber: log.blockNumber })
            else if (log.eventName === 'CallScheduled')
              scheduled.push({
                id: log.args.id,
                index: log.args.index,
                target: log.args.target,
                value: log.args.value,
                data: log.args.data,
                predecessor: log.args.predecessor,
                delay: log.args.delay,
                blockNumber: log.blockNumber,
              })
            else salts.push({ id: log.args.id, salt: log.args.salt })
          return { scheduled, salts, cancels }
        },
      },
      ctx.historyBudget,
      {
        until: startedAt + ctx.historyMs,
        parallel: HISTORY_PARALLEL_RANGES,
      }
    )
  } catch (error) {
    return unreadable(`the log scan failed: ${describe(error)}`, timelock)
  }
  if (floorNote) notes.push(floorNote)
  if (scan.historyError !== undefined)
    notes.push(
      `no endpoint would serve the next history range: ${redactUrls(
        scan.historyError
      )
        .split('\n')[0]
        ?.slice(0, 200)}`
    )
  if (!scan.historyComplete) {
    flagUnverified = true
    notes.push(
      `history before block ${scan.state.low} is not scanned yet; an operation scheduled earlier is not yet visible`
    )
  }

  let now: bigint
  let latestBlock: bigint
  let liveMinimum: bigint | undefined
  try {
    const latest = await client.getBlock()
    now = latest.timestamp
    latestBlock = latest.number
  } catch (error) {
    return unreadable(
      `the latest block could not be read: ${describe(error)}`,
      timelock
    )
  }
  try {
    liveMinimum = await client.readContract({
      address: timelock,
      abi: TIMELOCK_READ_ABI,
      functionName: 'getMinDelay',
    })
  } catch {
    liveMinimum = undefined
  }

  const agreedMinimum = BigInt(timelockConfig.minDelay)
  if (liveMinimum === undefined) {
    flagUnverified = true
    notes.push('getMinDelay() could not be read')
  } else if (liveMinimum < agreedMinimum) {
    flagMismatch = true
    notes.push(
      `the timelock's minimum delay is ${liveMinimum}s, below the agreed ${agreedMinimum}s`
    )
  }
  const known = knownAddresses(deployments, network.safeAddress, timelock)
  // The call-target names go in last, so a wallet sharing an address with the
  // Safe or the timelock can never relabel it.
  const knownForArguments = new Map<string, string>()
  for (const [key, value] of Object.entries(globalConfig))
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value))
      knownForArguments.set(value.toLowerCase(), key)
  for (const [address, label] of known) knownForArguments.set(address, label)
  const safeOwners = new Set(
    globalConfig.safeOwners.map((owner) => owner.toLowerCase())
  )
  const operations: IOperationReport[] = []
  const livePending = new Set<string>()

  for (const op of Object.values(scan.state.operations)) {
    let readyAt: bigint | undefined
    let stage: TOperationStage | undefined
    try {
      readyAt = await client.readContract({
        address: timelock,
        abi: TIMELOCK_READ_ABI,
        functionName: 'getTimestamp',
        args: [op.id],
        // Pinned, so a fallback endpoint behind this block errors instead of
        // reading 0 for an operation it has not seen.
        blockNumber: latestBlock,
      })
      stage = stageOf(readyAt, now)
      // A node behind the scheduling block reads 0 for an operation it has not
      // seen yet; that read says nothing about whether it was cancelled.
      if (stage === 'unset' && latestBlock < BigInt(op.blockNumber))
        stage = undefined
    } catch {
      stage = undefined
    }
    const unsetReads = stage === 'unset' ? (op.unsetReads ?? 0) + 1 : 0
    if (
      stage === 'done' ||
      (stage === 'unset' &&
        (isProvenCancelled(op, scan.state.cancels) ||
          unsetReads >= UNSET_READS_BEFORE_DROP))
    ) {
      delete scan.state.operations[op.id]
      delete ctx.state.codehash[findingKey(name, op.id)]
      continue
    }
    if (stage !== undefined)
      scan.state.operations[op.id] =
        unsetReads > 0
          ? { ...op, unsetReads }
          : { ...op, unsetReads: undefined }
    livePending.add(op.id.toLowerCase())

    const identity = gradeIdentity(op.id, recomputeOperationIds(op))
    const checks: ICheckOutcome[] = [
      identity.outcome,
      gradeState(stage, readyAt),
      gradeDelay(op, agreedMinimum, liveMinimum, timelock),
      gradeTargets(op, known),
      gradeDelegatecall(op),
      gradeAuthority(op, {
        known: knownForArguments,
        safeOwners,
        installed: installedAddresses(
          collectDiamondCutTargets(encodeOperation(op))
        ),
      }),
    ]

    let signTimeRecordPresent = false
    const opNotes: string[] = []
    try {
      signTimeRecordPresent = await ctx.signedSetExists(name, op.id)
    } catch (error) {
      opNotes.push(
        `the sign-time record store could not be read: ${describe(error)}`
      )
    }

    let authorities: ICheckOutcome
    try {
      authorities = gradeAuthorities(
        await runPreBroadcastGate(
          {
            operationId: op.id,
            targets: op.calls.map((c) => c.target),
            payloads: op.calls.map((c) => c.data),
          },
          {
            ...viemGateReaders(client),
            deployments,
            pinnedDeployments: deployments,
            globalConfig: globalConfig as unknown as Record<string, unknown>,
            signTimeRecord: signTimeRecordPresent ? {} : null,
            readScheduledAt: viemScheduledAtReader(client, timelock, op.id),
          }
        )
      )
    } catch (error) {
      authorities = gradeAuthorities({ error: describe(error) })
    }
    checks.push(authorities)

    const codehash = gradeCodehash(
      await runCodehash(name, op, client, ctx, network.isZkEVM)
    )
    checks.push(codehash)

    if (!signTimeRecordPresent)
      opNotes.push(
        'no sign-time record: this operation was not signed through confirm-safe-tx'
      )
    if (
      !('error' in ctx.queue) &&
      !ctx.queue.get(name)?.has(op.id.toLowerCase())
    )
      opNotes.push(
        'not in the execution queue, so the executor cron will not run it'
      )

    const { verdict, reasons } = classifyOperation(checks)
    const decision = evaluateCancelDecision(
      buildWatcherCancelInput({
        identity: identity.leg,
        codehash,
        authorities,
        stage,
        signTimeRecordPresent,
      })
    )
    operations.push({
      id: op.id,
      calls: op.calls.length,
      scheduledInBlock: op.blockNumber,
      verdict,
      checks,
      reasons,
      cancelRecommendation: renderCancelDecision(decision),
      notes: opNotes,
    })
  }

  if ('error' in ctx.queue)
    notes.push(
      `the execution queue could not be read for a cross-check: ${ctx.queue.error}`
    )
  else
    for (const queued of ctx.queue.get(name) ?? [])
      if (!livePending.has(queued))
        try {
          const readyAt = await client.readContract({
            address: timelock,
            abi: TIMELOCK_READ_ABI,
            functionName: 'getTimestamp',
            args: [queued as Hex],
          })
          if (readyAt > 1n) {
            flagUnverified = true
            notes.push(
              `queued operation ${queued} is pending on chain but the log scan did not find it`
            )
          }
        } catch (error) {
          flagUnverified = true
          notes.push(
            `queued operation ${queued} could not be checked on chain: ${describe(
              error
            )}`
          )
        }

  // A network that overran its timeout was already reported unreadable; its
  // late result must not overwrite the state that report kept.
  if (!ctx.expired.has(name)) ctx.state.networks[name] = scan.state
  const base = {
    network: name,
    status: 'watched' as const,
    timelock,
    scan: {
      floor: scan.state.floor ?? '0',
      low: scan.state.low ?? '0',
      high: scan.state.high ?? '0',
      historyComplete: scan.historyComplete,
      logCalls: scan.logCalls,
      scheduledLogs: scan.scheduledLogs,
    },
    operations,
    notes,
  }
  return {
    ...base,
    verdict: networkVerdict(base, {
      mismatch: flagMismatch,
      unverified: flagUnverified,
    }),
  }
}

/**
 * The findings the dedupe judges: one per network, one per pending operation.
 *
 * @param reports - This run's network reports.
 * @returns The findings.
 */
export const findingsOf = (
  reports: readonly INetworkReport[]
): IWatchFinding[] =>
  reports.flatMap((r) => [
    {
      key: findingKey(r.network, 'network'),
      network: r.network,
      verdict: r.verdict,
      reasons: [r.reason, ...r.notes].filter((x): x is string => Boolean(x)),
    },
    ...r.operations.map((op) => ({
      key: findingKey(r.network, op.id),
      network: r.network,
      verdict: op.verdict,
      reasons: op.reasons,
    })),
  ])

const command = defineCommand({
  meta: {
    name: 'timelock-watcher',
    description:
      'Report-only: re-check every pending timelock operation and alert on mismatch',
  },
  args: {
    network: {
      type: 'string',
      description: 'Watch only this network',
      required: false,
    },
    stateFile: {
      type: 'string',
      description: `Scan cursors and alert records carried between runs (default ${DEFAULT_STATE_FILE})`,
      required: false,
    },
    summaryFile: {
      type: 'string',
      description:
        'Where to write the Markdown report (default: $GITHUB_STEP_SUMMARY)',
      required: false,
    },
    historyBudget: {
      type: 'string',
      description: `eth_getLogs calls per network for the history backfill (default ${DEFAULT_HISTORY_BUDGET})`,
      required: false,
    },
    historyMinutes: {
      type: 'string',
      description: `Minutes per network for the history backfill (default ${DEFAULT_HISTORY_MINUTES})`,
      required: false,
    },
    codehashBudget: {
      type: 'string',
      description: `Gate K rebuilds per run (default ${DEFAULT_CODEHASH_BUDGET})`,
      required: false,
    },
  },
  async run({ args }) {
    const stateFile = args.stateFile ?? DEFAULT_STATE_FILE
    const historyBudget = Number(args.historyBudget ?? DEFAULT_HISTORY_BUDGET)
    const codehashBudget = Number(
      args.codehashBudget ?? DEFAULT_CODEHASH_BUDGET
    )
    const historyMinutes = Number(
      args.historyMinutes ?? DEFAULT_HISTORY_MINUTES
    )
    if (!(historyMinutes >= 0))
      throw new Error('--historyMinutes must be a non-negative number')
    if (!Number.isInteger(historyBudget) || historyBudget < 0)
      throw new Error('--historyBudget must be a non-negative integer')
    if (!Number.isInteger(codehashBudget) || codehashBudget < 0)
      throw new Error('--codehashBudget must be a non-negative integer')

    const all = Object.values(networksConfig as INetworksObject).filter(
      (n) => n.status === 'active' && n.type !== 'testnet'
    )
    const networks = args.network
      ? all.filter((n) => n.name === args.network?.toLowerCase())
      : all
    if (networks.length === 0)
      throw new Error(`No active production network matches ${args.network}`)

    const state = await loadWatcherState(stateFile)
    const readPinned = createPinnedBlobReader()
    let codehashDeps: ISignTimeCodehashDeps | undefined
    const store = await openWatcherStore()
    const ctx: IRunContext = {
      state,
      queue: store.queue,
      signedSetExists: store.signedSetExists,
      historyBudget,
      historyMs: historyMinutes * 60 * 1000,
      readPinned,
      codehash: {
        budget: { left: codehashBudget },
        deps: () =>
          (codehashDeps ??= createSignTimeCodehashDeps({
            readPinnedBlob: readPinned,
          })),
      },
      expired: new Set<string>(),
    }

    let reports: INetworkReport[]
    try {
      reports = await mapPooled(networks, NETWORK_CONCURRENCY, async (n) => {
        try {
          const started = Date.now()
          const report = await withTimeout(
            watchNetwork(n, ctx),
            ctx.historyMs + NETWORK_OVERHEAD_MS,
            `watching ${n.name}`
          )
          consola.info(
            `[${n.name}] ${report.status}, ${report.verdict}, ${
              report.operations.length
            } pending, ${Math.round((Date.now() - started) / 1000)}s`
          )
          return report
        } catch (error) {
          ctx.expired.add(n.name)
          return {
            network: n.name,
            status: 'unreadable' as const,
            reason: `the watcher failed on this network: ${describe(error)}`,
            verdict: 'unverified' as const,
            operations: [],
            notes: [],
          }
        }
      })
    } finally {
      await codehashDeps?.close()
      await store.close()
    }

    const now = new Date()
    const settled = new Set(
      reports
        .filter((r) => r.status === 'watched' || r.status === 'uncovered')
        .map((r) => r.network)
    )
    const decision = decideAlerts(
      state.alerts,
      findingsOf(reports),
      settled,
      now
    )
    const runUrl = process.env.TIMELOCK_WATCHER_RUN_URL
    const text = renderSlackAlert(decision.alerts, runUrl)
    let deliveryFailed = false
    if (text) {
      const webhook = process.env.WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS
      if (!isUnattendedRun())
        consola.info(`Slack alert (not posted from a local run):\n${text}`)
      else if (!webhook) {
        consola.error(
          'Alert delivery failed: there are alerts to send and no Slack webhook is configured'
        )
        deliveryFailed = true
      } else
        try {
          await new SlackNotifier(webhook, runUrl).sendNotificationWithRetry(
            { text },
            3,
            true
          )
          state.alerts = decision.next
        } catch (error) {
          consola.error(`Alert delivery failed: ${describe(error)}`)
          deliveryFailed = true
        }
    } else state.alerts = decision.next

    await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`)

    const summary = renderJobSummary(reports, now)
    const summaryFile = args.summaryFile ?? process.env.GITHUB_STEP_SUMMARY
    if (summaryFile) await writeFile(summaryFile, summary, { flag: 'a' })
    consola.log(summary)

    const tally = tallyReports(reports)
    const networkMismatch = reports.some((r) => r.verdict === 'mismatch')
    consola.info(
      `Checked ${tally.watched} of ${tally.networks} network(s): ${tally.operations} pending operation(s), ${tally.byVerdict.mismatch} mismatch, ${tally.byVerdict.unverified} unverified, ${tally.byVerdict.ok} ok; ${tally.unreadable} unreadable, ${tally.uncovered} not covered, ${tally.skipped} skipped`
    )
    if (
      tally.unreadable > 0 ||
      tally.byVerdict.mismatch > 0 ||
      networkMismatch ||
      deliveryFailed
    )
      process.exit(1)
    // A timed-out rebuild keeps running after its network was reported; it must
    // not hold the job open.
    process.exit(0)
  },
})

if (isEntrypoint(import.meta.url)) void runMain(command)
