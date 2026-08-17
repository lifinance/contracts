/**
 * Deferred diamond-cleanup queue — reconcile + TTL job.
 *
 * Standalone counterpart to the drain (design: docs/DeferredDiamondCleanupQueue.md
 * §7/§8). Three responsibilities, all idempotent and safe to run on a cron:
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
 *  3. **Safe-to-prune report** — name the `deployments/*.json` entries whose
 *     parked removal work is fully terminal, so the deferred log cleanup (spec
 *     §8 deploy-log longevity) happens as a deliberate reviewed PR instead of
 *     never.
 *
 * The pure decisions ({@link reconcileDecision}, {@link computeTtlAlerts},
 * {@link formatTtlAlertMessage}, {@link computeSafeToPrune},
 * {@link formatSafeToPruneReport}) are fully unit-tested; only the live CLI wiring
 * (Mongo/loupe/Slack) is unit-test exempt, mirroring `getParkedTasksCollection()`.
 * Dry-run by default (#2047 convention); pass `--yes` to apply transitions and
 * send the alert.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import { getAddress } from 'viem'

import type { SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { SlackNotifier } from '../../utils/slack-notifier'
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

/** A deploy-log entry whose parked removal work is fully terminal — safe to prune. */
export interface ISafeToPruneEntry {
  network: string
  environment: IParkedTask['environment']
  facet: string
}

/**
 * Returns the (network, facet) deploy-log entries that are safe to prune: at
 * least one task for the pair reached `executed`/`superseded` (the facet is
 * gone from the diamond) and none is still open. `cancelled`-only groups are
 * never safe — a cancelled intent means the facet may still be registered.
 * Entries whose log row is already gone are filtered via `hasLogEntry`.
 *
 * @param tasks - Candidate tasks (any status).
 * @param hasLogEntry - Whether `deployments/<network>[.<env>].json` still lists the facet.
 * @returns Prunable entries, de-duplicated, in first-seen order.
 */
export function computeSafeToPrune(
  tasks: IParkedTask[],
  hasLogEntry: (entry: ISafeToPruneEntry) => boolean
): ISafeToPruneEntry[] {
  const groups = new Map<string, IParkedTask[]>()
  for (const t of tasks) {
    const key = `${t.network}|${t.environment}|${t.facetName}`
    const list = groups.get(key) ?? []
    list.push(t)
    groups.set(key, list)
  }

  const safe: ISafeToPruneEntry[] = []
  for (const list of groups.values()) {
    const first = list[0]
    if (!first) continue
    const gone = list.some(
      (t) => t.status === 'executed' || t.status === 'superseded'
    )
    const open = list.some(
      (t) => t.status === 'queued' || t.status === 'proposed'
    )
    if (!gone || open) continue
    const entry: ISafeToPruneEntry = {
      network: first.network,
      environment: first.environment,
      facet: first.facetName,
    }
    if (hasLogEntry(entry)) safe.push(entry)
  }
  return safe
}

/**
 * Formats the safe-to-prune report, grouped by network. Returns `''` when
 * nothing is prunable so the caller can skip printing.
 */
export function formatSafeToPruneReport(entries: ISafeToPruneEntry[]): string {
  if (entries.length === 0) return ''
  const byNetwork = new Map<string, ISafeToPruneEntry[]>()
  for (const e of entries) {
    const list = byNetwork.get(e.network) ?? []
    list.push(e)
    byNetwork.set(e.network, list)
  }
  const lines = [
    `🧹 ${entries.length} deploy-log entr(ies) are safe to prune — every parked removal for them is terminal (open a PR removing the deployments/*.json rows):`,
  ]
  for (const [network, list] of byNetwork) {
    lines.push(`[${network}]`)
    for (const e of list) lines.push(`   - ${e.facet}`)
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
 * fetched once each. Fault-isolated per network: a retired network (dropped from
 * `config/networks.json` while its tasks were parked) or a failing RPC must never
 * abort the sweep — one dead network previously froze reconciliation for the
 * whole fleet (4/4 weekly cron runs died on a retired network's tasks).
 *
 * @returns The networks whose reconcile failed (empty when the sweep completed).
 */
async function reconcileAll(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined,
  apply: boolean
): Promise<string[]> {
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
    return []
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

  const failed: string[] = []
  try {
    for (const tasks of byNetworkEnv.values()) {
      const first = tasks[0]
      if (!first) continue
      const { network, environment } = first
      if (!networks[network]) {
        consola.warn(
          `[${network}:${environment}] network is no longer in config/networks.json (retired) — its ${tasks.length} open task(s) can never drain or reconcile. Cancel them (markCancelled) or migrate. Skipping.`
        )
        continue
      }
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
        failed.push(network)
        consola.error(
          `[${network}:${environment}] reconcile failed — continuing with remaining networks: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      }
    }
  } finally {
    await safeMongoClient?.close()
  }
  return failed
}

/**
 * Prints which deploy-log entries are now safe to prune (run after the
 * reconcile so freshly-applied transitions count). Log presence is checked
 * against the repo's `deployments/*.json`; a missing log file counts as
 * already pruned. Report-only — the actual pruning is a reviewed PR.
 */
async function reportSafeToPrune(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined
): Promise<void> {
  const all = await listParkedTasks(parkedTasks, { network: networkFilter })
  const logsByKey = new Map<string, Record<string, string> | undefined>()
  for (const t of all) {
    const key = `${t.network}:${t.environment}`
    if (logsByKey.has(key)) continue
    try {
      logsByKey.set(
        key,
        await getDeployments(t.network as SupportedChain, t.environment)
      )
    } catch {
      logsByKey.set(key, undefined)
    }
  }
  const entries = computeSafeToPrune(all, (e) =>
    Boolean(logsByKey.get(`${e.network}:${e.environment}`)?.[e.facet])
  )
  const report = formatSafeToPruneReport(entries)
  if (report) consola.info(report)
  else consola.info('No deploy-log entries are ready to prune')
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
      const failedNetworks = await reconcileAll(
        parkedTasks,
        args.network,
        apply
      )
      await runTtlAlert(parkedTasks, args.network, ttlDays, apply)
      await reportSafeToPrune(parkedTasks, args.network)
      // Surface a partial sweep as a failed job (never a silent green), but only
      // after the TTL alert + prune report ran for the networks that succeeded.
      if (failedNetworks.length > 0) {
        consola.error(
          `Reconcile incomplete — ${
            failedNetworks.length
          } network(s) failed: ${failedNetworks.join(
            ', '
          )}. Re-run with --network <X> after fixing.`
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
