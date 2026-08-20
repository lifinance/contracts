/**
 * Deferred diamond-cleanup queue — reconcile + TTL job.
 *
 * Standalone counterpart to the drain (design: docs/DeferredDiamondCleanupQueue.md
 * §7/§8). Two responsibilities, both idempotent and safe to run on a cron:
 *
 *  1. **Reconcile** open tasks against on-chain truth. The loupe is primary — if a
 *     parked facet's address is no longer routed, the removal is done: a claimed
 *     (`proposed`) task whose linked proposal executed becomes `executed`, anything
 *     else that is already gone becomes `superseded` (removed via another route).
 *     A `proposed` task whose linked proposal `reverted` while the facet is still
 *     present is reverted to `queued` so the next drain re-proposes. The
 *     `pendingTransactions` proposal status is an OPTIONAL signal: with tunnel
 *     access (`SC_MONGODB_URI`) the job distinguishes executed vs superseded and
 *     detects reverts; without it (loupe-only) a gone facet is `superseded`.
 *
 *  2. **TTL alert** — surface open tasks that have aged past the TTL (default 60d)
 *     to the github-ci-notifications Slack channel, so a cold network that never gets
 *     another cut is never silently orphaned (spec §8 backstop). The same alert
 *     carries what the reconcile could not resolve: tasks on a network retired from
 *     `config/networks.json` (permanent orphans — no RPC, no deploy log, no future
 *     cut) and network groups that errored this run.
 *
 * The sweep is per-network fault-isolated in both directions: a retired network is
 * partitioned out before any I/O and a group that throws is recorded and skipped.
 * The alert therefore always runs, and only a group that errored fails the process.
 *
 * The pure decisions ({@link reconcileDecision}, {@link computeTtlAlerts},
 * {@link formatTtlAlertMessage}, {@link partitionRetiredNetworks} and the alert
 * section formatters) are fully unit-tested; only the live CLI wiring
 * (Mongo/loupe/Slack) is unit-test exempt, mirroring `getParkedTasksCollection()`.
 * Dry-run by default (#2047 convention); pass `--yes` to apply transitions and
 * send the alert.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress } from 'viem'

import { type EnvironmentEnum } from '../../common/types'
import { isUnattendedRun, SlackNotifier } from '../../utils/slack-notifier'
import { getEnvVar } from '../../utils/utils'
import { networks } from '../../utils/viemScriptHelpers'

import { fetchOnChainFacets, resolveDiamondAddress } from './diamondRemovalDiff'
import {
  getParkedTasksCollection,
  listParkedTasks,
  markExecuted,
  markSuperseded,
  revertToQueued,
  type IParkedTask,
  type ParkedTaskStatus,
} from './parked-tasks'
import { getSafeMongoCollection, type SafeTxStatus } from './safe-utils'

/** Milliseconds in a day. */
const DAY_MS = 24 * 60 * 60 * 1000

/** Default cold-network TTL before a "still open" alert fires (spec §14 Q10). */
const DEFAULT_TTL_DAYS = 60

/** Lifecycle transition the reconcile should apply to a task. */
export type ReconcileDecision = 'executed' | 'superseded' | 'revert' | 'keep'

/** On-chain / proposal truth for one task, gathered by the live adapter. */
export interface IReconcileContext {
  /** Whether the task's facet address is still routed by the diamond loupe. */
  facetPresentOnChain: boolean
  /** Linked proposal status, if `SC_MONGODB_URI` (tunnel) was reachable. */
  proposalStatus?: SafeTxStatus
}

/**
 * Decides the lifecycle transition for one open parked task from on-chain truth
 * (spec §7 state machine). Loupe-primary: a facet that is gone is terminal
 * (`executed` when its own proposal executed, else `superseded`); a still-present
 * facet whose linked proposal reverted goes back to `queued`; everything else is
 * left untouched.
 *
 * @param task - The open task (only its `status` matters here).
 * @param ctx - On-chain presence + optional linked-proposal status.
 * @returns The transition to apply (`keep` = no change).
 */
export function reconcileDecision(
  task: Pick<IParkedTask, 'status'>,
  ctx: IReconcileContext
): ReconcileDecision {
  if (!ctx.facetPresentOnChain) {
    if (task.status === 'proposed' && ctx.proposalStatus === 'executed')
      return 'executed'
    return 'superseded'
  }
  if (task.status === 'proposed' && ctx.proposalStatus === 'reverted')
    return 'revert'
  return 'keep'
}

/** An open task that has aged past the TTL, for the cold-network alert. */
export interface IStaleParkedTask {
  network: string
  facet: string
  prUrl: string
  status: ParkedTaskStatus
  ageDays: number
}

/**
 * Returns the open (`queued`/`proposed`) tasks whose age (now − `createdAt`) has
 * reached `ttlDays`. Terminal tasks are never flagged. Both open states are
 * included so a stuck `proposed` task (reverted or never signed) is surfaced too,
 * not only a `queued` one awaiting a drain (spec §8, extended).
 *
 * @param tasks - Candidate tasks (any status).
 * @param now - Reference time (injected for determinism).
 * @param ttlDays - Age threshold in days.
 * @returns The stale open tasks, in input order.
 */
export function computeTtlAlerts(
  tasks: IParkedTask[],
  now: Date,
  ttlDays: number
): IStaleParkedTask[] {
  const open: ParkedTaskStatus[] = ['queued', 'proposed']
  const stale: IStaleParkedTask[] = []
  for (const t of tasks) {
    if (!open.includes(t.status)) continue
    const ageDays = Math.floor((now.getTime() - t.createdAt.getTime()) / DAY_MS)
    if (ageDays < ttlDays) continue
    stale.push({
      network: t.network,
      facet: t.facetName,
      prUrl: t.prUrl,
      status: t.status,
      ageDays,
    })
  }
  return stale
}

/**
 * Formats the cold-network TTL alert, grouped by network. Returns `''` when there
 * is nothing stale so the caller can skip sending.
 *
 * @param stale - Stale tasks from {@link computeTtlAlerts}.
 * @param ttlDays - The threshold used, for the header.
 * @returns A Slack-ready message, or `''` if `stale` is empty.
 */
export function formatTtlAlertMessage(
  stale: IStaleParkedTask[],
  ttlDays: number
): string {
  if (stale.length === 0) return ''
  const byNetwork = new Map<string, IStaleParkedTask[]>()
  for (const s of stale) {
    const list = byNetwork.get(s.network) ?? []
    list.push(s)
    byNetwork.set(s.network, list)
  }
  const lines = [
    `⏳ ${stale.length} deferred diamond-cleanup task(s) still open after ${ttlDays}d — run \`cleanUpProdDiamond --auto --network <X>\` or investigate:`,
  ]
  for (const [network, list] of byNetwork) {
    lines.push(`[${network}]`)
    for (const s of list)
      lines.push(`   - ${s.facet} (${s.status}, ${s.ageDays}d) → ${s.prUrl}`)
  }
  return lines.join('\n')
}

/** An open task whose network `config/networks.json` no longer knows. */
export interface IOrphanedParkedTask {
  network: string
  environment: EnvironmentEnum
  facet: string
  status: ParkedTaskStatus
  prUrl: string
}

/** A (network, environment) group the reconcile could not evaluate this run. */
export interface IReconcileFailure {
  network: string
  environment: EnvironmentEnum
  reason: string
  taskCount: number
}

/**
 * Splits open tasks into those whose network is still configured and those whose
 * network has been retired from `config/networks.json`.
 *
 * A retired network has no RPC, no deploy log and will never receive another
 * diamond cut, so its tasks can neither be reconciled against the loupe nor
 * drained — they are orphans awaiting a human cancel. Filtering them out
 * before any I/O is what keeps one retired network from aborting the whole sweep
 * (and with it the TTL backstop that runs after it).
 *
 * @param tasks - Open tasks (any network).
 * @param isNetworkKnown - Whether `config/networks.json` still has the network.
 * @returns The reconcilable tasks and the orphans, both in input order.
 */
export function partitionRetiredNetworks(
  tasks: IParkedTask[],
  isNetworkKnown: (network: string) => boolean
): { reconcilable: IParkedTask[]; orphaned: IOrphanedParkedTask[] } {
  const reconcilable: IParkedTask[] = []
  const orphaned: IOrphanedParkedTask[] = []
  for (const t of tasks) {
    if (isNetworkKnown(t.network)) {
      reconcilable.push(t)
      continue
    }
    orphaned.push({
      network: t.network,
      environment: t.environment,
      facet: t.facetName,
      status: t.status,
      prUrl: t.prUrl,
    })
  }
  return { reconcilable, orphaned }
}

/**
 * Formats the retired-network section of the alert. Returns `''` when there are no
 * orphans so the caller can drop the section.
 *
 * @param orphaned - Orphans from {@link partitionRetiredNetworks}.
 * @returns A Slack-ready section, or `''` if `orphaned` is empty.
 */
export function formatOrphanedTaskMessage(
  orphaned: IOrphanedParkedTask[]
): string {
  if (orphaned.length === 0) return ''
  const lines = [
    `🪦 ${orphaned.length} deferred diamond-cleanup task(s) sit on network(s) no longer in \`config/networks.json\` — they can never be drained; abandon them (\`revertToQueued\` first if \`proposed\`, then \`markCancelled\`) or re-add the network:`,
  ]
  for (const o of orphaned)
    lines.push(
      `   - [${o.network}:${o.environment}] ${o.facet} (${o.status}) → ${o.prUrl}`
    )
  return lines.join('\n')
}

/**
 * Formats the per-network failure section of the alert. Returns `''` when the sweep
 * evaluated every group.
 *
 * @param failures - Groups the reconcile skipped after an error.
 * @returns A Slack-ready section, or `''` if `failures` is empty.
 */
export function formatReconcileFailureMessage(
  failures: IReconcileFailure[]
): string {
  if (failures.length === 0) return ''
  const lines = [
    `❌ the reconcile could not evaluate ${failures.length} network/environment group(s) this run — their tasks keep their current status:`,
  ]
  for (const f of failures)
    lines.push(
      `   - [${f.network}:${f.environment}] ${f.taskCount} task(s): ${f.reason}`
    )
  return lines.join('\n')
}

/** Joins the non-empty alert sections; `''` when every section is empty. */
export function joinAlertSections(...sections: string[]): string {
  return sections.filter((s) => s !== '').join('\n\n')
}

export type TtlAlertDelivery = 'dry-run' | 'local' | 'misconfigured' | 'send'

/**
 * Decides what an applied run does with a computed TTL alert. A missing webhook on
 * the unattended run is a misconfiguration rather than a skip: the scheduled job
 * would otherwise stay green while the cold-network backstop it exists for is lost.
 *
 * @param apply - whether the run applies transitions (`--yes`) rather than dry-running.
 * @param unattended - {@link isUnattendedRun} for this process.
 * @param webhookUrl - `WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS`, if set.
 * @returns which delivery path the caller must take.
 */
export function ttlAlertDelivery(
  apply: boolean,
  unattended: boolean,
  webhookUrl: string | undefined
): TtlAlertDelivery {
  if (!apply) return 'dry-run'
  if (!unattended) return 'local'
  if (!webhookUrl) return 'misconfigured'
  return 'send'
}

// ───────────────────────── live adapter (unit-test exempt) ─────────────────────

type PendingTransactions = Awaited<
  ReturnType<typeof getSafeMongoCollection>
>['pendingTransactions']

/** Looks up a proposal's status by `safeTxHash` on the shared collection; `undefined` if no collection/hit. */
async function resolveProposalStatus(
  pendingTransactions: PendingTransactions | undefined,
  safeTxHash: string | undefined
): Promise<SafeTxStatus | undefined> {
  if (!safeTxHash || !pendingTransactions) return undefined
  const doc = await pendingTransactions.findOne({
    safeTxHash: { $eq: safeTxHash },
  })
  return doc?.status
}

/** What one reconcile sweep could not resolve, for the alert and the exit code. */
interface IReconcileOutcome {
  orphaned: IOrphanedParkedTask[]
  failures: IReconcileFailure[]
}

/**
 * Reconciles every open task, grouped by (network, environment) so the loupe is
 * fetched once each. Never throws for a single group: a retired network is
 * partitioned out before any I/O and a group that errors is recorded and skipped,
 * so one bad network cannot cost the rest of the sweep or the TTL alert that
 * follows it.
 */
async function reconcileAll(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined,
  apply: boolean
): Promise<IReconcileOutcome> {
  const allOpen = [
    ...(await listParkedTasks(parkedTasks, {
      network: networkFilter,
      status: 'queued',
    })),
    ...(await listParkedTasks(parkedTasks, {
      network: networkFilter,
      status: 'proposed',
    })),
  ]
  const { reconcilable: open, orphaned } = partitionRetiredNetworks(
    allOpen,
    (network) => networks[network] !== undefined
  )
  for (const o of orphaned)
    consola.warn(
      `[${o.network}:${o.environment}] ${o.facet} (${o.status}) → network retired from config/networks.json, cannot reconcile`
    )
  if (open.length === 0) {
    consola.info('No open parked tasks to reconcile')
    return { orphaned, failures: [] }
  }

  const byNetworkEnv = new Map<string, typeof open>()
  for (const t of open) {
    const key = `${t.network}:${t.environment}`
    const list = byNetworkEnv.get(key) ?? []
    list.push(t)
    byNetworkEnv.set(key, list)
  }

  // Open the (tunnel-gated) proposal store once for the whole run rather than
  // per task — a connection per task risks exhausting the pool.
  let safeMongoClient:
    | Awaited<ReturnType<typeof getSafeMongoCollection>>['client']
    | undefined
  let pendingTransactions: PendingTransactions | undefined
  if (process.env.SC_MONGODB_URI) {
    const col = await getSafeMongoCollection()
    safeMongoClient = col.client
    pendingTransactions = col.pendingTransactions
  }

  const failures: IReconcileFailure[] = []
  try {
    for (const tasks of byNetworkEnv.values()) {
      const first = tasks[0]
      if (!first) continue
      const { network, environment } = first
      try {
        const diamondAddress = await resolveDiamondAddress(network, environment)
        if (!diamondAddress) {
          consola.warn(
            `[${network}:${environment}] no LiFiDiamond in deploy log — skipping`
          )
          continue
        }
        const onChain = await fetchOnChainFacets(diamondAddress, network)
        const routed = new Set(onChain.map((f) => f.address.toLowerCase()))

        for (const task of tasks) {
          const proposalStatus = await resolveProposalStatus(
            pendingTransactions,
            task.safeTxHash
          )
          const decision = reconcileDecision(task, {
            facetPresentOnChain: routed.has(
              getAddress(task.facetAddress).toLowerCase()
            ),
            proposalStatus,
          })
          consola.info(
            `[${network}:${environment}] ${task.facetName} (${task.status}) → ${decision}`
          )
          if (!apply || decision === 'keep') continue
          if (decision === 'executed')
            await markExecuted(parkedTasks, task.taskKey)
          else if (decision === 'superseded')
            await markSuperseded(parkedTasks, task.taskKey)
          else if (decision === 'revert')
            await revertToQueued(parkedTasks, task.taskKey)
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        consola.error(
          `[${network}:${environment}] reconcile failed, continuing with the remaining networks: ${reason}`
        )
        failures.push({
          network,
          environment,
          reason,
          taskCount: tasks.length,
        })
      }
    }
  } finally {
    await safeMongoClient?.close()
  }
  return { orphaned, failures }
}

/**
 * Computes and (when applying) sends the queue alert: aged-past-TTL tasks plus
 * whatever the reconcile could not resolve, so an orphan on a retired network or a
 * network that errored is surfaced on the same weekly channel rather than only in
 * the job log.
 */
async function runQueueAlert(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined,
  ttlDays: number,
  apply: boolean,
  outcome: IReconcileOutcome
): Promise<void> {
  const all = await listParkedTasks(parkedTasks, { network: networkFilter })
  // A task on a retired network belongs in the orphan section only: the TTL section
  // tells the reader to drain the network, which is exactly what cannot be done there.
  const { reconcilable } = partitionRetiredNetworks(
    all,
    (network) => networks[network] !== undefined
  )
  const stale = computeTtlAlerts(reconcilable, new Date(), ttlDays)
  const message = joinAlertSections(
    formatTtlAlertMessage(stale, ttlDays),
    formatOrphanedTaskMessage(outcome.orphaned),
    formatReconcileFailureMessage(outcome.failures)
  )
  if (!message) {
    consola.info(
      `No parked tasks older than ${ttlDays}d, and every network reconciled`
    )
    return
  }
  consola.warn(message)
  const webhookUrl = process.env.WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS
  const delivery = ttlAlertDelivery(apply, isUnattendedRun(), webhookUrl)
  if (delivery === 'dry-run') return
  if (delivery === 'local') {
    consola.info(
      'Local run: alert logged only. Set CI=1 to deliver it to Slack.'
    )
    return
  }
  // 'misconfigured' — an unattended run reaching here has no webhook to post to.
  if (!webhookUrl)
    throw new Error(
      'WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS is unset, so the queue alert cannot be delivered. Set the SLACK_WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS repository secret.'
    )
  await new SlackNotifier(webhookUrl).sendNotificationWithRetry({
    text: message,
  })
}

const main = defineCommand({
  meta: {
    name: 'reconcile-parked-tasks',
    description:
      'Reconcile deferred diamond-cleanup tasks against on-chain truth and alert on aged ones',
  },
  args: {
    network: {
      type: 'string',
      description: 'Only reconcile this network (default: all)',
      required: false,
    },
    ttlDays: {
      type: 'string',
      description: `Age (days) that triggers the cold-network alert (default: ${DEFAULT_TTL_DAYS})`,
      required: false,
    },
    yes: {
      type: 'boolean',
      description:
        'Apply transitions and send the TTL alert (default: dry-run)',
      required: false,
    },
  },
  async run({ args }) {
    const ttlDays = args.ttlDays ? Number(args.ttlDays) : DEFAULT_TTL_DAYS
    const apply = args.yes ?? false
    if (!apply) consola.info('Dry-run — pass --yes to apply transitions/alert')
    // getParkedTasksCollection reads the un-gated MONGODB_URI cluster (no tunnel).
    getEnvVar('MONGODB_URI')
    const { client, parkedTasks } = await getParkedTasksCollection()
    let outcome: IReconcileOutcome
    try {
      outcome = await reconcileAll(parkedTasks, args.network, apply)
      await runQueueAlert(parkedTasks, args.network, ttlDays, apply, outcome)
    } finally {
      await client.close()
    }
    // Fail the run only for groups that errored — those are fixable (RPC, deploy
    // log, Mongo) and worth a red cron. Orphans on a retired network are a queue
    // data condition: they are reported in the alert every run until cancelled and
    // must not keep the job permanently red.
    if (outcome.failures.length > 0)
      throw new Error(
        `${
          outcome.failures.length
        } network/environment group(s) failed to reconcile: ${outcome.failures
          .map((f) => `${f.network}:${f.environment}`)
          .join(', ')}`
      )
  },
})

// Guard so importing the pure decisions (reconcile-parked-tasks.test.ts) does not
// launch the CLI; runs only when executed directly (mirrors list-timelock-queue.ts).
if (import.meta.main) runMain(main)
