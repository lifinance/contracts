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
 *     to the multisig-proposals Slack channel, so a cold network that never gets
 *     another cut is never silently orphaned (spec §8 backstop).
 *
 * A task whose network is no longer `active` in `config/networks.json` is abandoned
 * (`queued` → `cancelled`) instead of reconciled — there is no chain left to read.
 * Every step is isolated — a failing `(network, environment)` group or a failing
 * cancellation is logged, the rest of the fleet and the TTL alert still run, and the
 * process exits non-zero at the end.
 *
 * The pure decisions ({@link reconcileDecision}, {@link deprecatedNetworkDecision},
 * {@link partitionByNetworkStatus}, {@link computeTtlAlerts},
 * {@link formatTtlAlertMessage}) are fully unit-tested; only the live CLI wiring
 * (Mongo/loupe/Slack) is unit-test exempt, mirroring `getParkedTasksCollection()`.
 * Dry-run by default (#2047 convention); pass `--yes` to apply transitions and
 * send the alert.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress } from 'viem'

import { SlackNotifier } from '../../utils/slack-notifier'
import { getEnvVar } from '../../utils/utils'
import { getAllActiveNetworks } from '../../utils/viemScriptHelpers'

import { fetchOnChainFacets, resolveDiamondAddress } from './diamondRemovalDiff'
import {
  getParkedTasksCollection,
  listParkedTasks,
  markCancelled,
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
export type ReconcileDecision =
  | 'executed'
  | 'superseded'
  | 'revert'
  | 'cancel'
  | 'keep'

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

/**
 * Decides the transition for an open task whose network is no longer `active` in
 * `config/networks.json`. Such a network has no RPC config and no maintenance
 * intent left, so its removals are abandoned rather than reconciled against a
 * chain nobody can reach. A `proposed` task is left alone deliberately: it already
 * carries a live Safe removal proposal, and `markCancelled` is restricted to
 * `queued` so cancelling can never orphan that proposal from its origin-PR
 * linkage (spec §6/§7) — an operator reverts it first.
 *
 * @param task - The open task (only its `status` matters here).
 * @returns `cancel` for a `queued` task, `keep` for a claimed one.
 */
export function deprecatedNetworkDecision(
  task: Pick<IParkedTask, 'status'>
): Extract<ReconcileDecision, 'cancel' | 'keep'> {
  return task.status === 'queued' ? 'cancel' : 'keep'
}

/**
 * Splits open tasks by whether their network is still active, so the reconcile
 * never tries to resolve a chain that `config/networks.json` no longer describes.
 *
 * @param tasks - Open tasks to route.
 * @param activeNetworks - Network ids with `status: 'active'` in networks.json.
 * @returns `live` tasks for the on-chain path, `deprecated` ones for abandonment.
 */
export function partitionByNetworkStatus<
  T extends Pick<IParkedTask, 'network'>
>(
  tasks: readonly T[],
  activeNetworks: ReadonlySet<string>
): { live: T[]; deprecated: T[] } {
  const live: T[] = []
  const deprecated: T[] = []
  for (const task of tasks)
    if (activeNetworks.has(task.network)) live.push(task)
    else deprecated.push(task)
  return { live, deprecated }
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

/**
 * Reconciles every open task, grouped by (network, environment) so the loupe is
 * fetched once each.
 *
 * @returns How many steps failed (a network group, or a cancellation), so the
 * caller can fail the run *after* the TTL alert has had its chance to fire.
 */
async function reconcileAll(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined,
  apply: boolean
): Promise<number> {
  const open = [
    ...(await listParkedTasks(parkedTasks, {
      network: networkFilter,
      status: 'queued',
    })),
    ...(await listParkedTasks(parkedTasks, {
      network: networkFilter,
      status: 'proposed',
    })),
  ]
  if (open.length === 0) {
    consola.info('No open parked tasks to reconcile')
    return 0
  }

  let failures = 0
  const { live, deprecated } = partitionByNetworkStatus(
    open,
    new Set(getAllActiveNetworks().map((n) => n.id))
  )
  for (const task of deprecated) {
    const decision = deprecatedNetworkDecision(task)
    consola.info(
      `[${task.network}:${task.environment}] ${task.facetName} (${task.status}) → ${decision} (network no longer active)`
    )
    try {
      if (decision === 'keep')
        consola.warn(
          `[${task.network}:${task.environment}] ${task.facetName} is claimed on a deprecated network — revert it before cancelling so its Safe proposal is not orphaned`
        )
      else if (apply) await markCancelled(parkedTasks, task.taskKey)
    } catch (error: unknown) {
      failures++
      consola.error(
        `[${task.network}:${task.environment}] could not cancel ${
          task.facetName
        } — continuing: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  const byNetworkEnv = new Map<string, typeof open>()
  for (const t of live) {
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
      } catch (error: unknown) {
        // One unreachable network must not cost the fleet its reconcile or the TTL
        // alert — the cold-network backstop is the whole point of the cron.
        failures++
        consola.error(
          `[${network}:${environment}] reconcile failed — continuing: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  } finally {
    await safeMongoClient?.close()
  }
  return failures
}

/** Computes and (when applying) sends the cold-network TTL alert. */
async function runTtlAlert(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined,
  ttlDays: number,
  apply: boolean
): Promise<void> {
  const all = await listParkedTasks(parkedTasks, { network: networkFilter })
  const stale = computeTtlAlerts(all, new Date(), ttlDays)
  const message = formatTtlAlertMessage(stale, ttlDays)
  if (!message) {
    consola.info(`No parked tasks older than ${ttlDays}d`)
    return
  }
  consola.warn(message)
  const webhookUrl = process.env.WEBHOOK_DEV_SC_MULTISIG_PROPOSALS
  if (apply && webhookUrl)
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
    try {
      const failures = await reconcileAll(parkedTasks, args.network, apply)
      await runTtlAlert(parkedTasks, args.network, ttlDays, apply)
      if (failures > 0) {
        consola.error(
          `${failures} reconcile step(s) failed — see the errors above`
        )
        process.exitCode = 1
      }
    } finally {
      await client.close()
    }
  },
})

// Guard so importing the pure decisions (reconcile-parked-tasks.test.ts) does not
// launch the CLI; runs only when executed directly (mirrors list-timelock-queue.ts).
if (import.meta.main) runMain(main)
