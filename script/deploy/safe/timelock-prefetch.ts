/**
 * Fleet pre-check for the timelock executor: which networks have queued or
 * blocked ops.
 *
 * Lives outside `execute-pending-timelock-tx.ts` because that module calls
 * `runMain` at module scope and so cannot be imported by tests. Guarding that
 * call with `import.meta.main`, as some siblings in this directory do, would
 * make it importable but is deliberately not done there: should the flag ever
 * read falsy for that entry, the scheduled executor exits 0 having executed
 * nothing, and no observer can tell that apart from a clean run.
 */

import { existsSync } from 'fs'

import { consola } from 'consola'

import {
  EnvironmentEnum,
  type INetworksObject,
  type SupportedChain,
} from '../../common/types'
import {
  getDeployments,
  getDeploymentsFilePath,
} from '../../utils/deploymentHelpers'

import {
  getTimelockQueueCollection,
  type TimelockQueueStatus,
} from './timelock-queue'

/** Why a network carries no production timelock and is skipped during prefetch. */
export type TTimelockSkipReason = 'no-deployment-log' | 'no-timelock-deployed'

/** Result of pre-checking a network (queue only, no RPC). Used to decide which networks to process; processNetwork always opens a fresh RPC and re-fetches queued ops to verify on-chain readiness. */
export interface IPendingFetchResult {
  network: INetworksObject[string]
  /** Number of queued timelock ops for this network (on-chain ready count unknown until processNetwork runs). */
  pendingInMongoCount: number
  /**
   * Number of `blocked` timelock ops for this network. Never executed, but a
   * network with only blocked rows must still be processed so `alertBlockedOps`
   * can re-check them on-chain.
   */
  blockedInMongoCount: number
  /** Set when prefetch failed; callers must not treat as "no pending" without checking. */
  fetchError?: unknown
  /** Set when the network has no production timelock to check — an expected skip, not a failure. */
  skipReason?: TTimelockSkipReason
}

/** Statuses the prefetch tallies; every other status is settled and needs no run. */
const TALLIED_STATUSES = ['queued', 'blocked'] as const

/** Row shape the tally needs; the query projects away everything else. */
interface INetworkStatusRow {
  network: string
  status: TimelockQueueStatus
}

/** Per-network counts of the statuses that make a network worth processing. */
export interface IQueueTally {
  queued: number
  blocked: number
}

/**
 * Tallies queued and blocked ops per network, case-insensitively.
 *
 * @param rows - Rows in a tallied status, each carrying its network name.
 * @returns Lowercased network name → tally. Networks with no rows are absent.
 */
export function tallyOpsByNetwork(
  rows: INetworkStatusRow[]
): Map<string, IQueueTally> {
  const counts = new Map<string, IQueueTally>()
  for (const row of rows) {
    const key = row.network.toLowerCase()
    const tally = counts.get(key) ?? { queued: 0, blocked: 0 }
    if (row.status === 'blocked') tally.blocked++
    else tally.queued++
    counts.set(key, tally)
  }
  return counts
}

/** Opens the queue collection; injectable so the teardown path can be tested. */
export type TQueueConnector = typeof getTimelockQueueCollection

/**
 * Counts queued and blocked timelock ops for many networks in one query over one
 * connection.
 *
 * @param networkNames - Network names to count for (matched case-insensitively).
 * @param connect - Opens the queue collection; defaults to the real connection.
 * @returns Lowercased network name → queued and blocked op counts.
 */
export async function countOpsByNetwork(
  networkNames: string[],
  connect: TQueueConnector = getTimelockQueueCollection
): Promise<Map<string, IQueueTally>> {
  const { client, timelockQueue } = await connect()
  try {
    const rows = await timelockQueue
      .find(
        {
          network: { $in: networkNames.map((name) => name.toLowerCase()) },
          status: { $in: [...TALLIED_STATUSES] },
        },
        { projection: { network: 1, status: 1 } }
      )
      .toArray()
    return tallyOpsByNetwork(rows)
  } finally {
    // A rejecting close would otherwise replace an already-computed tally with a
    // throw, and since this is now the fleet's only connection that turns a
    // teardown hiccup into "every network failed to prefetch".
    await client
      .close()
      .catch((err: unknown) =>
        consola.warn('Failed to close the MongoDB connection:', err)
      )
  }
}

/**
 * Resolves whether a network has a production timelock worth querying.
 *
 * A missing deployments file is an expected state for an active network that
 * was never brought up in production (e.g. `tronshasta`), so it is reported as
 * a skip rather than an error — otherwise it is indistinguishable from a
 * genuine infrastructure failure in the prefetch summary.
 *
 * @param network - Network entry from `config/networks.json`.
 * @returns A skip reason, or `undefined` when the network has a timelock.
 */
export async function resolveTimelockSkipReason(
  network: INetworksObject[string]
): Promise<TTimelockSkipReason | undefined> {
  const chain = network.name as SupportedChain
  let deploymentData: { LiFiTimelockController?: string }
  try {
    deploymentData = (await getDeployments(
      chain,
      EnvironmentEnum.production
    )) as { LiFiTimelockController?: string }
  } catch (err) {
    // getDeployments reports a corrupt or unreadable file as not-found too, and
    // skipping one of those would hide a network that does have a timelock —
    // the very failure this prefetch exists to stop. Only an absent file skips.
    if (existsSync(getDeploymentsFilePath(chain, EnvironmentEnum.production)))
      throw err
    return 'no-deployment-log'
  }
  return deploymentData.LiFiTimelockController
    ? undefined
    : 'no-timelock-deployed'
}

/**
 * Assembles per-network results from the skip map and the queue tally.
 *
 * @param networks - Networks in the order results should be returned.
 * @param skipReasons - Network name → skip reason for networks with no timelock.
 * @param countsByNetwork - Lowercased network name → queued and blocked op counts.
 * @param errorsByNetwork - Network name → the error that stopped it being checked.
 * @returns One result per input network, in input order.
 */
export function assemblePrefetchResults(
  networks: INetworksObject[string][],
  skipReasons: Map<string, TTimelockSkipReason>,
  countsByNetwork: Map<string, IQueueTally>,
  errorsByNetwork: Map<string, unknown> = new Map()
): IPendingFetchResult[] {
  return networks.map((network) => {
    const empty = {
      network,
      pendingInMongoCount: 0,
      blockedInMongoCount: 0,
    }

    const skipReason = skipReasons.get(network.name)
    if (skipReason) return { ...empty, skipReason }

    const fetchError = errorsByNetwork.get(network.name)
    if (fetchError !== undefined) return { ...empty, fetchError }

    const tally = countsByNetwork.get(network.name.toLowerCase())
    return {
      network,
      pendingInMongoCount: tally?.queued ?? 0,
      blockedInMongoCount: tally?.blocked ?? 0,
    }
  })
}

/**
 * Pre-checks every network using the queue only (no RPC), over a single MongoDB
 * connection and a single query.
 *
 * Connection-per-network was the previous shape and does not scale: with a
 * `mongodb+srv://` URI every `MongoClient` resolves its own SRV *and* TXT
 * record before connecting, so fanning out over the fleet fired ~142 DNS
 * queries at once, the local resolver rate-limited them, and every network
 * whose lookup timed out was reported as "prefetch failed" and then silently
 * not checked for ready operations.
 *
 * @param networks - Networks to pre-check.
 * @returns One result per input network, in input order.
 */
export async function fetchPendingForNetworks(
  networks: INetworksObject[string][]
): Promise<IPendingFetchResult[]> {
  const skipReasons = new Map<string, TTimelockSkipReason>()
  const errorsByNetwork = new Map<string, unknown>()
  const resolved = await Promise.all(
    networks.map(async (network) => {
      try {
        return { network, skipReason: await resolveTimelockSkipReason(network) }
      } catch (err) {
        consola.error(
          `[${network.name}] Could not read the production deployments file:`,
          err
        )
        return { network, err }
      }
    })
  )
  for (const entry of resolved)
    if ('err' in entry) errorsByNetwork.set(entry.network.name, entry.err)
    else if (entry.skipReason)
      skipReasons.set(entry.network.name, entry.skipReason)

  const toCheck = networks.filter(
    (n) => !skipReasons.has(n.name) && !errorsByNetwork.has(n.name)
  )
  if (toCheck.length === 0)
    return assemblePrefetchResults(
      networks,
      skipReasons,
      new Map(),
      errorsByNetwork
    )

  try {
    const countsByNetwork = await countOpsByNetwork(toCheck.map((n) => n.name))
    return assemblePrefetchResults(
      networks,
      skipReasons,
      countsByNetwork,
      errorsByNetwork
    )
  } catch (err) {
    consola.error(
      `Prefetch failed for all ${toCheck.length} network(s) with a timelock — could not read the timelock queue:`,
      err
    )
    for (const network of toCheck) errorsByNetwork.set(network.name, err)
    return assemblePrefetchResults(
      networks,
      skipReasons,
      new Map(),
      errorsByNetwork
    )
  }
}

/** How a completed prefetch should be reported and whether the run may continue. */
export interface IPrefetchOutcome {
  withPending: IPendingFetchResult[]
  withBlocked: IPendingFetchResult[]
  /**
   * Networks worth opening an RPC for: queued ops to execute, blocked ops to
   * re-check, or both.
   */
  toProcess: IPendingFetchResult[]
  skipped: IPendingFetchResult[]
  failed: IPendingFetchResult[]
  /**
   * True when there is no work AND some networks could not be checked: "0
   * pending" is only trustworthy once every network was actually reached.
   */
  mustExitWithError: boolean
}

/**
 * Classifies prefetch results into the buckets the CLI reports on.
 *
 * A network with only `blocked` rows has nothing to execute but still belongs in
 * `toProcess`, so `alertBlockedOps` can re-check those rows on-chain.
 *
 * @param results - One result per pre-checked network.
 * @returns The classified outcome.
 */
export function classifyPrefetchResults(
  results: IPendingFetchResult[]
): IPrefetchOutcome {
  const withPending = results.filter((r) => r.pendingInMongoCount > 0)
  const withBlocked = results.filter((r) => r.blockedInMongoCount > 0)
  const toProcess = results.filter(
    (r) => r.pendingInMongoCount > 0 || r.blockedInMongoCount > 0
  )
  // Must match how assemblePrefetchResults records a failure: a falsy thrown
  // value would otherwise make the network read as checked-with-0-pending.
  const failed = results.filter((r) => r.fetchError !== undefined)
  return {
    withPending,
    withBlocked,
    toProcess,
    skipped: results.filter((r) => r.skipReason),
    failed,
    mustExitWithError: toProcess.length === 0 && failed.length > 0,
  }
}
