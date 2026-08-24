/**
 * Fleet pre-check for the timelock executor: which networks have queued ops.
 *
 * Split out of `execute-pending-timelock-tx.ts` so the logic is importable —
 * that module calls `runMain` at module scope, and the `import.meta.main` guard
 * used elsewhere in this directory is not an option there: the script runs via
 * `bunx tsx`, where `import.meta.main` is `undefined` and the guard would turn
 * the CLI into a silent no-op.
 */

import { consola } from 'consola'

import {
  EnvironmentEnum,
  type INetworksObject,
  type SupportedChain,
} from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'

import { getTimelockQueueCollection } from './timelock-queue'

/** Why a network carries no production timelock and is skipped during prefetch. */
export type TTimelockSkipReason = 'no-deployment-log' | 'no-timelock-deployed'

/** Result of pre-checking a network (queue only, no RPC). Used to decide which networks to process; processNetwork always opens a fresh RPC and re-fetches queued ops to verify on-chain readiness. */
export interface IPendingFetchResult {
  network: INetworksObject[string]
  /** Number of queued timelock ops for this network (on-chain ready count unknown until processNetwork runs). */
  pendingInMongoCount: number
  /** Set when prefetch failed; callers must not treat as "no pending" without checking. */
  fetchError?: unknown
  /** Set when the network has no production timelock to check — an expected skip, not a failure. */
  skipReason?: TTimelockSkipReason
}

/** Row shape the tally needs; the query projects away everything else. */
interface IQueuedNetworkRow {
  network: string
}

/**
 * Tallies queued ops per network, case-insensitively.
 *
 * @param rows - Queued rows, each carrying its network name.
 * @returns Lowercased network name → count. Networks with no rows are absent.
 */
export function tallyQueuedOpsByNetwork(
  rows: IQueuedNetworkRow[]
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = row.network.toLowerCase()
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

/**
 * Counts queued timelock ops for many networks in one query over one connection.
 *
 * @param networkNames - Network names to count for (matched case-insensitively).
 * @returns Lowercased network name → queued op count.
 */
export async function countQueuedOpsByNetwork(
  networkNames: string[]
): Promise<Map<string, number>> {
  const { client, timelockQueue } = await getTimelockQueueCollection()
  try {
    const rows = await timelockQueue
      .find(
        {
          network: { $in: networkNames.map((name) => name.toLowerCase()) },
          status: 'queued',
        },
        { projection: { network: 1 } }
      )
      .toArray()
    return tallyQueuedOpsByNetwork(rows)
  } finally {
    await client.close()
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
  let deploymentData: { LiFiTimelockController?: string }
  try {
    deploymentData = (await getDeployments(
      network.name as SupportedChain,
      EnvironmentEnum.production
    )) as { LiFiTimelockController?: string }
  } catch {
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
 * @param countsByNetwork - Lowercased network name → queued op count.
 * @param fetchError - When set, every non-skipped network is marked as failed.
 * @returns One result per input network, in input order.
 */
export function assemblePrefetchResults(
  networks: INetworksObject[string][],
  skipReasons: Map<string, TTimelockSkipReason>,
  countsByNetwork: Map<string, number>,
  fetchError?: unknown
): IPendingFetchResult[] {
  return networks.map((network) => {
    const skipReason = skipReasons.get(network.name)
    if (skipReason) return { network, pendingInMongoCount: 0, skipReason }
    if (fetchError !== undefined)
      return { network, pendingInMongoCount: 0, fetchError }
    return {
      network,
      pendingInMongoCount: countsByNetwork.get(network.name.toLowerCase()) ?? 0,
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
  for (const network of networks) {
    const skipReason = await resolveTimelockSkipReason(network)
    if (skipReason) skipReasons.set(network.name, skipReason)
  }

  const withTimelock = networks.filter((n) => !skipReasons.has(n.name))
  if (withTimelock.length === 0)
    return assemblePrefetchResults(networks, skipReasons, new Map())

  try {
    const countsByNetwork = await countQueuedOpsByNetwork(
      withTimelock.map((n) => n.name)
    )
    return assemblePrefetchResults(networks, skipReasons, countsByNetwork)
  } catch (err) {
    consola.error(
      `Prefetch failed for all ${withTimelock.length} network(s) with a timelock — could not read the timelock queue:`,
      err
    )
    return assemblePrefetchResults(networks, skipReasons, new Map(), err)
  }
}

/** How a completed prefetch should be reported and whether the run may continue. */
export interface IPrefetchOutcome {
  withPending: IPendingFetchResult[]
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
 * @param results - One result per pre-checked network.
 * @returns The classified outcome.
 */
export function classifyPrefetchResults(
  results: IPendingFetchResult[]
): IPrefetchOutcome {
  const withPending = results.filter((r) => r.pendingInMongoCount > 0)
  const failed = results.filter((r) => r.fetchError)
  return {
    withPending,
    skipped: results.filter((r) => r.skipReason),
    failed,
    mustExitWithError: withPending.length === 0 && failed.length > 0,
  }
}
