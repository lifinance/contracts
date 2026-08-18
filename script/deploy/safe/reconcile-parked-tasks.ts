/**
 * Deferred diamond-cleanup queue — reconcile + TTL job.
 *
 * Standalone counterpart to the drain (design: docs/DeferredDiamondCleanupQueue.md
 * §7/§8). Three responsibilities, all idempotent and safe to run on a cron:
 *
 *  1. **Reconcile** tasks against on-chain truth. The loupe is primary, and presence
 *     is resolved by facet NAME (see {@link resolveFacetPresence}) — if a parked
 *     facet is no longer routed, the removal is done: a claimed (`proposed`) task
 *     whose linked proposal executed becomes `executed`, anything else that is
 *     already gone becomes `superseded` (removed via another route).
 *     A `proposed` task whose linked proposal `reverted` while the facet is still
 *     present is reverted to `queued` so the next drain re-proposes. A task already
 *     resolved as done (`executed`/`superseded`) whose facet is STILL routed is a
 *     false resolution: it is reopened to `queued` and alerted, because a removal
 *     recorded as done was otherwise never re-checked and stayed invisible. The
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
 * Each (network, environment) is reconciled in isolation: the queue outlives
 * networks, so one retired chain can no longer abort the sweep and leave every
 * later network unverified. Skipped networks are alerted, never dropped silently.
 *
 * The pure decisions ({@link reconcileDecision}, {@link resolveFacetPresence},
 * {@link computeTtlAlerts}, {@link formatTtlAlertMessage},
 * {@link computeSafeToPrune}, {@link formatSafeToPruneReport}) are fully unit-tested;
 * only the live CLI wiring (Mongo/loupe/Slack) is unit-test exempt, mirroring
 * `getParkedTasksCollection()`.
 * Dry-run by default (#2047 convention); pass `--yes` to apply transitions and
 * send the alerts.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { type EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { SlackNotifier } from '../../utils/slack-notifier'
import { getEnvVar } from '../../utils/utils'

import {
  fetchOnChainFacets,
  resolveAddressToName,
  resolveDiamondAddress,
} from './diamondRemovalDiff'
import {
  getParkedTasksCollection,
  listParkedTasks,
  markExecuted,
  markSuperseded,
  reopenResolvedTask,
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
  | 'reopen'
  | 'keep'

/** Statuses that claim the removal is done and are therefore re-verified against the loupe. */
const RESOLVED_STATUSES: ParkedTaskStatus[] = ['executed', 'superseded']

/** On-chain / proposal truth for one task, gathered by the live adapter. */
export interface IReconcileContext {
  /**
   * Whether the task's facet is still routed by the diamond loupe — resolved by
   * facet NAME first, with the stored `facetAddress` only as a fallback. See
   * {@link resolveFacetPresence} for why the name must lead.
   */
  facetPresentOnChain: boolean
  /** Linked proposal status, if `SC_MONGODB_URI` (tunnel) was reachable. */
  proposalStatus?: SafeTxStatus
}

/**
 * Decides the lifecycle transition for one parked task from on-chain truth
 * (spec §7 state machine). Loupe-primary in both directions:
 *
 * - A task claiming to be done (`executed`/`superseded`) whose facet is still
 *   routed is a false resolution — reopened to `queued` so the next drain
 *   re-proposes it. Without this, a removal that never executed is invisible
 *   forever, since terminal states were previously never re-checked.
 * - An open task whose facet is gone becomes terminal (`executed` when its own
 *   proposal executed, else `superseded`).
 * - An open, still-present task whose linked proposal reverted goes back to `queued`.
 *
 * `cancelled` is never revisited — it records a deliberate operator decision.
 *
 * @param task - The task (only its `status` matters here).
 * @param ctx - On-chain presence + optional linked-proposal status.
 * @returns The transition to apply (`keep` = no change).
 */
export function reconcileDecision(
  task: Pick<IParkedTask, 'status'>,
  ctx: IReconcileContext
): ReconcileDecision {
  if (task.status === 'cancelled') return 'keep'

  if (RESOLVED_STATUSES.includes(task.status))
    return ctx.facetPresentOnChain ? 'reopen' : 'keep'

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
 * Resolves whether a parked task's facet is still routed by the diamond.
 *
 * Address-only, matching the drain: a task targets one exact address
 * (`computeFacetRemovalsByAddress`), so presence must be judged the same way or
 * the two disagree about what "done" means. Judging by NAME would strand every
 * co-registered removal — once superseded SymbiosisFacet v1.0.0 is cut, v2.0.0
 * still routes under that name, so a name check would report the task's facet as
 * present forever and it would never reconcile (EXSC-750/EXSC-775).
 *
 * The name is still worth checking, but as an anomaly signal rather than as
 * presence — see {@link isSuspectAddressSnapshot}.
 *
 * @param task - The task's facet identity (its stored address snapshot).
 * @param routedAddresses - Lowercased addresses currently routed by the loupe.
 * @returns `true` while that exact address is still routed.
 */
export function resolveFacetPresence(
  task: Pick<IParkedTask, 'facetAddress'>,
  routedAddresses: Set<string>
): boolean {
  return routedAddresses.has(task.facetAddress.toLowerCase())
}

/**
 * Flags a task whose stored address is gone while a facet of its name is still
 * routed — the shape of a wrong address snapshot, which reconcile must not
 * silently resolve.
 *
 * This is the worldchain `AcrossFacetV3` failure: the task carried lisk's
 * address, so an address check truthfully answered "not routed", the task was
 * resolved as `executed`, and the facet stayed live for 18 days. It is NOT the
 * same shape as a legitimate co-registered removal, where the parked address is
 * gone *because it was just removed* — that case is only distinguishable by
 * whether the name's live address differs from the parked one, so the caller
 * treats a hit as an alert to investigate, never as a resolution.
 *
 * @param task - The task's facet identity (name + stored address snapshot).
 * @param routedNames - Facet names currently routed, resolved via the deploy log.
 * @param routedAddresses - Lowercased addresses currently routed by the loupe.
 * @returns `true` when the address is absent but the name is still routed.
 */
export function isSuspectAddressSnapshot(
  task: Pick<IParkedTask, 'facetName' | 'facetAddress'>,
  routedNames: Set<string>,
  routedAddresses: Set<string>
): boolean {
  return (
    !routedAddresses.has(task.facetAddress.toLowerCase()) &&
    routedNames.has(task.facetName)
  )
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

/** A task that claimed to be done while its facet is still routed. */
export interface IReopenedParkedTask {
  network: string
  facet: string
  prUrl: string
  /** The terminal status the task was reopened from. */
  from: ParkedTaskStatus
}

/** A (network, environment) whose on-chain state could not be read, so its tasks went unverified. */
export interface IReconcileFailure {
  network: string
  environment: EnvironmentEnum
  reason: string
}

/** Outcome of one reconcile sweep. */
export interface IReconcileRun {
  reopened: IReopenedParkedTask[]
  /** Networks skipped because their state was unreadable — never silently dropped. */
  failures: IReconcileFailure[]
}

/**
 * Formats the unreconciled-network alert. Returns `''` when every network was
 * verified.
 *
 * A network whose state cannot be read has its parked tasks verified by nothing at
 * all, which is the same invisibility this job exists to prevent — so a skip is
 * always reported rather than quietly tolerated.
 *
 * @param failures - Networks skipped during the sweep.
 * @returns A Slack-ready message, or `''` if `failures` is empty.
 */
export function formatReconcileFailureMessage(
  failures: IReconcileFailure[]
): string {
  if (failures.length === 0) return ''
  const lines = [
    `⚠️ ${failures.length} network(s) could not be reconciled — their parked tasks were NOT verified this run:`,
  ]
  for (const f of failures)
    lines.push(`   - ${f.network}:${f.environment} — ${f.reason}`)
  // Without a remedy this alert repeats every run forever: a retired network can
  // never be reconciled, so its tasks have to be cancelled to clear the backlog.
  lines.push(
    '   → transient RPC/config problem: no action needed. Retired network: cancel its parked tasks so the queue stops tracking a chain that no longer exists.'
  )
  return lines.join('\n')
}

/**
 * Formats the false-resolution alert. Returns `''` when nothing was reopened so
 * the caller can skip sending.
 *
 * This is the loud half of the fix: a reopened task is proof that a removal we
 * recorded as done never landed, which is exactly the failure that previously left
 * a deprecated facet live and unmonitored.
 *
 * @param reopened - Tasks reopened by this run.
 * @returns A Slack-ready message, or `''` if `reopened` is empty.
 */
export function formatReopenAlertMessage(
  reopened: IReopenedParkedTask[]
): string {
  if (reopened.length === 0) return ''
  const byNetwork = new Map<string, IReopenedParkedTask[]>()
  for (const r of reopened) {
    const list = byNetwork.get(r.network) ?? []
    list.push(r)
    byNetwork.set(r.network, list)
  }
  const lines = [
    `🚨 ${reopened.length} deferred diamond-cleanup task(s) were marked done but their facet is STILL ROUTED — re-queued for removal:`,
  ]
  for (const [network, list] of byNetwork) {
    lines.push(`[${network}]`)
    for (const r of list)
      lines.push(`   - ${r.facet} (was ${r.from}) → ${r.prUrl}`)
  }
  return lines.join('\n')
}

// ───────────────────────── live adapter (unit-test exempt) ─────────────────────

type PendingTransactions = Awaited<
  ReturnType<typeof getSafeMongoCollection>
>['pendingTransactions']

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
 * Reconciles every task that is not `cancelled`, grouped by (network, environment)
 * so the loupe and deploy log are fetched once each.
 *
 * Resolved (`executed`/`superseded`) tasks are re-verified alongside open ones:
 * trusting a stored terminal status is what made a removal that never executed
 * invisible indefinitely. Reopened tasks are returned so the caller can alert.
 */
async function reconcileAll(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined,
  apply: boolean
): Promise<IReconcileRun> {
  const candidates = (
    await listParkedTasks(parkedTasks, { network: networkFilter })
  ).filter((t) => t.status !== 'cancelled')
  if (candidates.length === 0) {
    consola.info('No parked tasks to reconcile')
    return { reopened: [], failures: [] }
  }

  const reopened: IReopenedParkedTask[] = []
  const failures: IReconcileFailure[] = []
  const byNetworkEnv = new Map<string, typeof candidates>()
  for (const t of candidates) {
    const key = `${t.network}:${t.environment}`
    const list = byNetworkEnv.get(key) ?? []
    list.push(t)
    byNetworkEnv.set(key, list)
  }

  // Open the (tunnel-gated) proposal store once for the whole run rather than
  // per task — a connection per task risks exhausting the pool. The proposal
  // status is an OPTIONAL signal (module header): SC_MONGODB_URI being set does
  // not mean the tunnel is up, and an unreachable signing store must degrade to
  // loupe-only reconciliation, never abort the sweep.
  let safeMongoClient:
    | Awaited<ReturnType<typeof getSafeMongoCollection>>['client']
    | undefined
  let pendingTransactions: PendingTransactions | undefined
  if (process.env.SC_MONGODB_URI)
    try {
      const col = await getSafeMongoCollection()
      safeMongoClient = col.client
      pendingTransactions = col.pendingTransactions
    } catch (error: unknown) {
      consola.warn(
        `Signing store unreachable — reconciling loupe-only (executed vs superseded indistinguishable; reverted proposals undetected): ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }

  try {
    for (const tasks of byNetworkEnv.values()) {
      const first = tasks[0]
      if (!first) continue
      const { network, environment } = first
      // Per-network isolation: the queue outlives networks (a retired chain keeps
      // its parked tasks but leaves `networks.json`, so the loupe read throws), and
      // one such chain must not abort the sweep. Every network ordered after it
      // would otherwise never be reconciled at all — silently.
      let onChain: Awaited<ReturnType<typeof fetchOnChainFacets>>
      let addressToName: Record<string, string>
      try {
        const diamondAddress = await resolveDiamondAddress(network, environment)
        if (!diamondAddress) {
          consola.warn(
            `[${network}:${environment}] no LiFiDiamond in deploy log — skipping`
          )
          failures.push({
            network,
            environment,
            reason: 'no LiFiDiamond in deploy log',
          })
          continue
        }
        ;[onChain, addressToName] = await Promise.all([
          fetchOnChainFacets(diamondAddress, network),
          resolveAddressToName(network, environment),
        ])
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        consola.warn(
          `[${network}:${environment}] cannot read on-chain state — skipping: ${reason}`
        )
        failures.push({ network, environment, reason })
        continue
      }

      const routedAddresses = new Set(
        onChain.map((f) => f.address.toLowerCase())
      )
      const routedNames = new Set(
        onChain
          .map((f) => addressToName[f.address.toLowerCase()])
          .filter((name): name is string => name !== undefined)
      )

      for (const task of tasks) {
        const proposalStatus = await resolveProposalStatus(
          pendingTransactions,
          task.safeTxHash
        )
        const decision = reconcileDecision(task, {
          facetPresentOnChain: resolveFacetPresence(task, routedAddresses),
          proposalStatus,
        })
        consola.info(
          `[${network}:${environment}] ${task.facetName} (${task.status}) → ${decision}`
        )
        if (isSuspectAddressSnapshot(task, routedNames, routedAddresses))
          consola.warn(
            `[${network}:${environment}] ${task.facetName}: parked address ${task.facetAddress} is not routed, but a facet named ${task.facetName} still is. ` +
              `Expected when a superseded version was just removed; a wrong address snapshot looks identical — verify before trusting "${decision}". Origin PR: ${task.prUrl}`
          )
        if (decision === 'keep') continue
        if (decision === 'reopen') {
          // Recorded in dry-run too, so the false-resolution alert is visible
          // without --yes; only the Slack send is gated on applying.
          if (!apply || (await reopenResolvedTask(parkedTasks, task.taskKey)))
            reopened.push({
              network,
              facet: task.facetName,
              prUrl: task.prUrl,
              from: task.status,
            })
          continue
        }
        if (!apply) continue
        if (decision === 'executed')
          await markExecuted(parkedTasks, task.taskKey)
        else if (decision === 'superseded')
          await markSuperseded(parkedTasks, task.taskKey)
        else if (decision === 'revert')
          await revertToQueued(parkedTasks, task.taskKey)
      }
    }
  } finally {
    await safeMongoClient?.close()
  }
  return { reopened, failures }
}

/** Logs and (when applying) sends the reconcile sweep's alerts. */
async function runReconcileAlerts(
  run: IReconcileRun,
  apply: boolean
): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_DEV_SC_MULTISIG_PROPOSALS
  const send = async (message: string): Promise<void> => {
    if (apply && webhookUrl)
      await new SlackNotifier(webhookUrl).sendNotificationWithRetry({
        text: message,
      })
  }

  const reopenMessage = formatReopenAlertMessage(run.reopened)
  if (reopenMessage) {
    consola.error(reopenMessage)
    await send(reopenMessage)
  }

  const failureMessage = formatReconcileFailureMessage(run.failures)
  if (failureMessage) {
    consola.warn(failureMessage)
    await send(failureMessage)
  }
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
      const run = await reconcileAll(parkedTasks, args.network, apply)
      await runReconcileAlerts(run, apply)
      await runTtlAlert(parkedTasks, args.network, ttlDays, apply)
      await reportSafeToPrune(parkedTasks, args.network)
    } finally {
      await client.close()
    }
  },
})

// Guard so importing the pure decisions (reconcile-parked-tasks.test.ts) does not
// launch the CLI; runs only when executed directly (mirrors list-timelock-queue.ts).
if (import.meta.main) runMain(main)
