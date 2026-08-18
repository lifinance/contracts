/**
 * Deferred diamond-cleanup queue — reconcile + TTL job.
 *
 * Standalone counterpart to the drain (design: docs/DeferredDiamondCleanupQueue.md
 * §7/§8). Three responsibilities, all idempotent and safe to run on a cron:
 *
 *  1. **Reconcile** tasks against on-chain truth. The loupe is primary, and presence
 *     is resolved by the task's stored facet ADDRESS (see
 *     {@link resolveFacetPresence}) — if that exact facet is no longer routed, the
 *     removal is done: a claimed (`proposed`) task
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
 *     to the github-ci-notifications Slack channel, so a cold network that never gets
 *     another cut is never silently orphaned (spec §8 backstop).
 *
 *  3. **Safe-to-prune report** — name the `deployments/*.json` entries whose
 *     parked removal work is fully terminal, so the deferred log cleanup (spec
 *     §8 deploy-log longevity) happens as a deliberate reviewed PR instead of
 *     never.
 *
 * Each (network, environment) is reconciled in isolation: the queue outlives
 * networks, so one retired chain can no longer abort the sweep and leave every
 * later network unverified. Skipped networks are alerted, never dropped silently,
 * and the sweep as a whole is guarded so a failure to start still leaves the alerts
 * and the TTL backstop running.
 *
 * A task whose network is outside the active set in `config/networks.json` is routed
 * out before the loupe is touched — there is no chain to read — and reported with the
 * command that resolves it. Cancelling it is opt-in and single-network
 * (`--network <x> --cancel-deprecated --yes`, see {@link shouldCancelDeprecated});
 * the cron never cancels, because that config is narrowed for pause rehearsals.
 *
 * The pure decisions ({@link reconcileDecision}, {@link resolveFacetPresence},
 * {@link deprecatedNetworkDecision}, {@link partitionByNetworkStatus},
 * {@link shouldCancelDeprecated}, {@link parseTtlDays}, {@link computeTtlAlerts},
 * {@link formatTtlAlertMessage},
 * {@link computeSafeToPrune}, {@link formatSafeToPruneReport}) are fully unit-tested;
 * only the live CLI wiring (Mongo/loupe/Slack) is unit-test exempt, mirroring
 * `getParkedTasksCollection()`.
 * Dry-run by default (#2047 convention); pass `--yes` to apply transitions and
 * send the alerts.
 */

import 'dotenv/config'

import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'

import { EnvironmentEnum, type SupportedChain } from '../../common/types'
import { getDeployments } from '../../utils/deploymentHelpers'
import { isUnattendedRun, SlackNotifier } from '../../utils/slack-notifier'
import { getEnvVar } from '../../utils/utils'
import { getAllActiveNetworks } from '../../utils/viemScriptHelpers'

import {
  collectActiveSelectors,
  fetchOnChainFacets,
  getExpectedFacetNames,
  getFacetSourceNames,
  getSourceContractNames,
  resolveAddressToName,
  resolveDiamondAddress,
} from './diamondRemovalDiff'
import {
  getParkedTasksCollection,
  listParkedTasks,
  markCancelled,
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

/** Memoized `src/` walk — the sweep asks the same question for every network. */
let sourceContractNamesCache: Set<string> | undefined
const cachedSourceContractNames = (): Set<string> =>
  (sourceContractNamesCache ??= getSourceContractNames())

/**
 * Selector union owned by the network's target-state facets, or `undefined` when it
 * cannot be read. `collectActiveSelectors` throws on a missing artifact — correct for
 * the removal engine, which must fail closed, but here it is only one input to a
 * reopen decision that already withholds on `undefined`, and a reconcile sweep must
 * not die on a stale build.
 *
 * @param expectedNames - Target-state `LiFiDiamond` names for the network.
 * @returns Lowercased selectors, or `undefined` if unavailable.
 */
function resolveActiveSelectors(
  expectedNames: Set<string> | undefined
): Set<string> | undefined {
  if (!expectedNames) return undefined
  try {
    const facetNames = getFacetSourceNames()
    return collectActiveSelectors(
      [...expectedNames].filter((name) => facetNames.has(name))
    )
  } catch {
    return undefined
  }
}

/** Default cold-network TTL before a "still open" alert fires (spec §14 Q10). */
const DEFAULT_TTL_DAYS = 60

/** Lifecycle transition the reconcile should apply to a task. */
export type ReconcileDecision =
  | 'executed'
  | 'superseded'
  | 'revert'
  | 'reopen'
  | 'cancel'
  | 'keep'

/** Statuses that claim the removal is done and are therefore re-verified against the loupe. */
const RESOLVED_STATUSES: ParkedTaskStatus[] = ['executed', 'superseded']

/** On-chain / proposal truth for one task, gathered by the live adapter. */
export interface IReconcileContext {
  /**
   * Whether the task's facet is still routed by the diamond loupe — resolved by
   * the stored `facetAddress` alone. See {@link resolveFacetPresence} for why the
   * address must lead, and {@link isSuspectAddressSnapshot} for the name check
   * that survives as an anomaly signal.
   */
  facetPresentOnChain: boolean
  /** Linked proposal status, if `SC_MONGODB_URI` (tunnel) was reachable. */
  proposalStatus?: SafeTxStatus
  /**
   * Whether the facet is still *deprecated* — source deleted AND absent from
   * `_targetState.json`, the same gate the removal engine uses. `undefined` when it
   * could not be determined (no target-state entry for the network). Only a
   * deprecated facet may be re-queued for removal: an address that is routed again
   * because it was legitimately re-cut (an incident rollback, or a CREATE2 redeploy
   * landing on the same address) must not have its removal resurrected.
   */
  facetDeprecated?: boolean
}

/**
 * Decides the lifecycle transition for one parked task from on-chain truth
 * (spec §7 state machine). Loupe-primary in both directions:
 *
 * - A task claiming to be done (`executed`/`superseded`) whose facet is still
 *   routed AND still deprecated is a false resolution — reopened to `queued` so the
 *   next drain re-proposes it. Without this, a removal that never executed is
 *   invisible forever, since terminal states were previously never re-checked. A
 *   routed facet that is no longer removable is a deliberate re-add, so the removal
 *   stays retired (see {@link isParkedFacetStillRemovable}).
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

  if (RESOLVED_STATUSES.includes(task.status)) {
    if (!ctx.facetPresentOnChain) return 'keep'
    return ctx.facetDeprecated === true ? 'reopen' : 'keep'
  }

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
/**
 * Whether a parked facet is still *removable* — the gate a reopen must pass before a
 * retired removal is re-queued.
 *
 * Name-level deprecation (source deleted AND absent from target state) is the common
 * case, but it cannot answer the co-registered one: the superseded SymbiosisFacet
 * v1.0.0 shares its name with a live v2.0.0 that target state expects and whose
 * source exists (EXSC-750), so a name-only gate would withhold exactly the reopen
 * EXSC-774 exists for. An address the deploy log does not name therefore falls back
 * to selectors: the log holds the live address for every name it knows, so an
 * unlogged routed address is a superseded version, and it is removable when none of
 * the selectors it routes belongs to a facet target state still expects — the same
 * held-back rule the removal engine applies. Verified on real mainnet data: v1 routes
 * `0xb70fb9a5`/`0x6e067161`, neither in the 156-selector active union, while the live
 * v2 owns `0xe23b7a08`/`0xc46059b2`.
 *
 * Fails to `undefined` (the caller then withholds) whenever the inputs cannot answer it.
 *
 * @param params - Task identity plus the network's target state, sources, log and loupe facts.
 * @returns `true` removable, `false` deliberately live, `undefined` undecidable.
 */
export function isParkedFacetStillRemovable(params: {
  facetName: string
  facetAddress: string
  /** Lowercased address → deploy-log name for this network. */
  addressToName: Record<string, string>
  /** Target-state `LiFiDiamond` names, or `undefined` when the network has no entry. */
  expectedNames: Set<string> | undefined
  sourceNames: Set<string>
  /** Lowercased selectors owned by target-state facets, or `undefined` if unavailable. */
  activeSelectors: Set<string> | undefined
  /** Selectors the loupe routes to the parked address. */
  routedSelectors: string[]
}): boolean | undefined {
  const { facetName, expectedNames, sourceNames } = params
  if (!expectedNames) return undefined
  if (!expectedNames.has(facetName) && !sourceNames.has(facetName)) return true

  const logged = params.addressToName[params.facetAddress.toLowerCase()]
  if (logged !== undefined) return false

  const activeSelectors = params.activeSelectors
  if (!activeSelectors) return undefined
  return params.routedSelectors.every(
    (selector) => !activeSelectors.has(selector.toLowerCase())
  )
}

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

/**
 * Decides which transition an open task on a non-active network is ELIGIBLE for.
 * The chain cannot be read — `getViemChainForNetworkName` throws for a key that is
 * absent from `config/networks.json`, and no `ETH_NODE_URI_<NETWORK>` is configured
 * for one that is not active — so the removal can never be verified and abandoning
 * the intent is the only terminal answer available.
 *
 * Eligibility is not permission: whether the cancellation is applied is
 * {@link shouldCancelDeprecated}'s call, because leaving the active set is not by
 * itself proof of deprecation. A `proposed` task is never eligible — it carries a
 * live Safe removal proposal, and `markCancelled` is restricted to `queued` so
 * cancelling can never orphan that proposal from its origin-PR linkage (spec
 * §6/§7); it needs `revertToQueued` first, for which no operator CLI exists yet
 * (EXSC-715). A task already terminal needs nothing.
 *
 * @param task - The task (only its `status` matters here).
 * @returns `cancel` for a `queued` task, `keep` for everything else.
 */
export function deprecatedNetworkDecision(
  task: Pick<IParkedTask, 'status'>
): Extract<ReconcileDecision, 'cancel' | 'keep'> {
  return task.status === 'queued' ? 'cancel' : 'keep'
}

/**
 * Whether a deprecated-network task may actually be cancelled on this run.
 *
 * `config/networks.json` is NOT a deprecation signal: it is narrowed to a handful
 * of networks for emergency-pause rehearsals (`f99db1607`, `216bad0e4`, both
 * reverted days later — and both DELETE entries, so absence is no safer a signal
 * than `status`) and `status` is toggled back to `active` (`51a04fc64`). Replaying
 * `216bad0e4`'s config against the live queue routes 65 of 67 open tasks to this
 * path, and `cancelled` is terminal with no undo. So cancellation requires an
 * operator who named ONE network and passed `--cancel-deprecated --yes`; the
 * unattended cron only ever reports.
 *
 * @param decision - Transition from {@link deprecatedNetworkDecision}.
 * @param opts.apply - Whether the run applies transitions (`--yes`).
 * @param opts.cancelDeprecated - Whether `--cancel-deprecated` was passed.
 * @param opts.networkFilter - The `--network` value; cancelling fleet-wide is refused.
 * @returns `true` only for an opted-in, applied, single-network cancellation.
 */
export function shouldCancelDeprecated(
  decision: ReconcileDecision,
  opts: {
    apply: boolean
    cancelDeprecated: boolean
    networkFilter: string | undefined
  }
): boolean {
  // Truthiness, not `!== undefined`: citty yields '' for a bare `--network`, and
  // listParkedTasks treats '' as no filter at all — i.e. the whole fleet.
  return (
    decision === 'cancel' &&
    opts.apply &&
    opts.cancelDeprecated &&
    Boolean(opts.networkFilter)
  )
}

/**
 * Splits tasks by whether their network is still active, so the sweep never tries
 * to resolve a chain that `config/networks.json` no longer describes.
 *
 * @param tasks - Tasks to route.
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

/**
 * Parses the `--ttlDays` flag. `Number()` alone would accept `NaN`, negatives and
 * fractions, and a `NaN` threshold makes `ageDays < ttlDays` false for EVERY task —
 * turning the cold-network alert into a fleet-wide one.
 *
 * @param raw - The raw flag value, or `undefined` when it was not passed.
 * @returns The threshold in days.
 * @throws If the value is not a positive integer.
 */
export function parseTtlDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TTL_DAYS
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`--ttlDays must be a positive integer (got "${raw}")`)
  return parsed
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

/**
 * A task whose reconcile decision was WITHHELD because the data contradicts itself.
 * Never resolved silently: an anomaly is the one signal that something the queue
 * believes about the chain is wrong, so it is alerted and left for a human.
 */
export interface IReconcileAnomaly {
  network: string
  environment: EnvironmentEnum
  facet: string
  prUrl: string
  /** Why no transition was applied, phrased for the operator reading Slack. */
  reason: string
}

/** Outcome of one reconcile sweep. */
export interface IReconcileRun {
  reopened: IReopenedParkedTask[]
  /** Networks skipped because their state was unreadable — never silently dropped. */
  failures: IReconcileFailure[]
  /** Tasks left untouched because their on-chain data was self-contradictory. */
  anomalies: IReconcileAnomaly[]
  /**
   * `${network}:${environment}` → lowercased addresses the loupe reported, for the
   * networks this run actually read. Reused by the safe-to-prune report so it does
   * not re-sweep the fleet; an absent key means "not read", never "nothing routed".
   */
  routedByNetworkEnv: Map<string, Set<string>>
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
  // Keeps the worst case (a fleet-wide narrowing) under SlackNotifier's 2900-char budget.
  const MAX_LISTED = 15
  // One entry per (network, environment), so the headline counts physical networks
  // rather than rows — two failing environments of one chain is still one network.
  const networkCount = new Set(failures.map((f) => f.network)).size
  const lines = [
    `⚠️ ${networkCount} network(s) could not be reconciled — their parked tasks were NOT verified this run:`,
  ]
  for (const f of failures.slice(0, MAX_LISTED))
    lines.push(`   - ${f.network}:${f.environment} — ${f.reason}`)
  if (failures.length > MAX_LISTED)
    lines.push(
      `   … and ${
        failures.length - MAX_LISTED
      } more — see the job log for the full list.`
    )
  // Without a remedy this alert repeats every run forever: a retired network can
  // never be reconciled, so its tasks have to be cancelled to clear the backlog.
  // The caveat is not optional — a config narrowed for a pause rehearsal is
  // indistinguishable from a deprecation here, and cancelling cannot be undone.
  lines.push(
    '   → transient RPC/config problem: no action needed.',
    '   → outside the active set: if the network really is gone for good, clear it with `reconcile-parked-tasks --network <x> --cancel-deprecated --yes` (one network at a time).',
    "   → CHECK FIRST: networks.json is temporarily narrowed during emergency-pause rehearsals, which looks identical to a deprecation here. Cancelling a live network's tasks is irreversible."
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

/**
 * Formats the withheld-decision alert. Returns '' when nothing was withheld.
 *
 * The job runs unattended, so a console warning next to a decision reaches nobody —
 * an anomaly that never leaves the job log is a silent resolution with extra steps.
 *
 * @param anomalies - Tasks whose transition was withheld this run.
 * @returns A Slack-ready message, or '' if `anomalies` is empty.
 */
export function formatReconcileAnomalyMessage(
  anomalies: IReconcileAnomaly[]
): string {
  if (anomalies.length === 0) return ''
  const MAX_LISTED = 15
  const lines = [
    `⚠️ ${anomalies.length} deferred diamond-cleanup task(s) were left UNCHANGED because their on-chain data is contradictory — a human has to adjudicate:`,
  ]
  for (const a of anomalies.slice(0, MAX_LISTED))
    lines.push(
      `   - [${a.network}:${a.environment}] ${a.facet}: ${a.reason} → ${a.prUrl}`
    )
  if (anomalies.length > MAX_LISTED)
    lines.push(
      `   … and ${
        anomalies.length - MAX_LISTED
      } more — see the job log for the full list.`
    )
  return lines.join('\n')
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

/** A deploy-log entry whose parked removal work is fully terminal — safe to prune. */
export interface ISafeToPruneEntry {
  network: string
  environment: IParkedTask['environment']
  facet: string
}

/**
 * Returns the (network, facet) deploy-log entries that are safe to prune: at
 * least one task for the pair reached `executed`/`superseded` (that facet is
 * gone from the diamond) and none is still open. `cancelled`-only groups are
 * never safe — a cancelled intent means the facet may still be registered.
 * Entries whose log row is already gone are filtered via `hasLogEntry`.
 *
 * Tasks group by NAME here because a deploy-log row is what gets pruned, and the
 * log holds one row per name. Removals are address-keyed (EXSC-775), so a group's
 * tasks may cover a *superseded* version while the row points at the live one —
 * `isLoggedAddressRouted` holds those back, since pruning the row would orphan a
 * registered facet from the log.
 *
 * @param tasks - Candidate tasks (any status).
 * @param hasLogEntry - Whether `deployments/<network>[.<env>].json` still lists the facet.
 * @param isLoggedAddressRouted - Whether the address that row points at is still on the diamond.
 * @returns Prunable entries, de-duplicated, in first-seen order.
 */
export function computeSafeToPrune(
  tasks: IParkedTask[],
  hasLogEntry: (entry: ISafeToPruneEntry) => boolean,
  isLoggedAddressRouted: (entry: ISafeToPruneEntry) => boolean
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
    if (hasLogEntry(entry) && !isLoggedAddressRouted(entry)) safe.push(entry)
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
  apply: boolean,
  cancelDeprecated: boolean
): Promise<IReconcileRun> {
  const candidates = (
    await listParkedTasks(parkedTasks, { network: networkFilter })
  ).filter((t) => t.status !== 'cancelled')
  if (candidates.length === 0) {
    consola.info('No parked tasks to reconcile')
    return {
      reopened: [],
      failures: [],
      anomalies: [],
      routedByNetworkEnv: new Map(),
    }
  }

  const reopened: IReopenedParkedTask[] = []
  const routedByNetworkEnv = new Map<string, Set<string>>()
  const failures: IReconcileFailure[] = []
  const anomalies: IReconcileAnomaly[] = []

  // Routed out before the loupe is touched: a task on a network outside the active
  // set has no chain to read, so it would otherwise fail per-network every week
  // with no way to resolve it.
  const { live, deprecated } = partitionByNetworkStatus(
    candidates,
    new Set(getAllActiveNetworks().map((n) => n.id))
  )
  // Grouped per (network, environment): one alert line per network, not per task —
  // a fleet-wide narrowing otherwise posts one line for every open task.
  const deprecatedByNetwork = new Map<
    string,
    { network: string; environment: EnvironmentEnum; blocked: string[] }
  >()
  let terminalSkipped = 0
  for (const task of deprecated) {
    const decision = deprecatedNetworkDecision(task)
    if (decision === 'keep' && task.status !== 'proposed') {
      // Terminal on a network we cannot read: nothing to do, but it is no longer
      // covered by the false-resolution re-check, so it is counted, not silent.
      terminalSkipped++
      continue
    }
    const cancelling = shouldCancelDeprecated(decision, {
      apply,
      cancelDeprecated,
      networkFilter,
    })
    consola.info(
      `[${task.network}:${task.environment}] ${task.facetName} (${
        task.status
      }) → ${decision}${
        cancelling ? '' : ' (reported only)'
      } (network not active in networks.json)`
    )
    const key = `${task.network}:${task.environment}`
    const group = deprecatedByNetwork.get(key) ?? {
      network: task.network,
      environment: task.environment,
      blocked: [],
    }
    deprecatedByNetwork.set(key, group)

    if (decision === 'keep') {
      group.blocked.push(
        `${task.facetName} (claimed — needs revertToQueued first)`
      )
      continue
    }
    if (!cancelling) {
      group.blocked.push(task.facetName)
      continue
    }
    try {
      // A concurrent drain can flip queued→proposed between the read and this
      // write, in which case the store refuses and returns null — the log must not
      // claim a cancellation that did not happen.
      if ((await markCancelled(parkedTasks, task.taskKey)) === null)
        group.blocked.push(
          `${task.facetName} (no longer queued — not cancelled)`
        )
    } catch (error: unknown) {
      group.blocked.push(
        `${task.facetName} (cancel failed: ${
          error instanceof Error ? error.message : String(error)
        })`
      )
    }
  }
  if (terminalSkipped > 0)
    consola.info(
      `${terminalSkipped} resolved task(s) on networks outside the active set were not re-verified this run`
    )
  for (const g of deprecatedByNetwork.values())
    if (g.blocked.length > 0)
      failures.push({
        network: g.network,
        environment: g.environment,
        reason: `outside the active set in networks.json — ${
          g.blocked.length
        } parked task(s) not reconciled: ${g.blocked.join(', ')}`,
      })

  const byNetworkEnv = new Map<string, typeof candidates>()
  for (const t of live) {
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
      routedByNetworkEnv.set(`${network}:${environment}`, routedAddresses)
      const routedNames = new Set(
        onChain
          .map((f) => addressToName[f.address.toLowerCase()])
          .filter((name): name is string => name !== undefined)
      )

      // A facet may only be re-queued for removal while it is still removable — the
      // same gates the removal engine applies, so eval and remover cannot disagree.
      const expectedNames = getExpectedFacetNames(network, environment)
      const activeSelectors = resolveActiveSelectors(expectedNames)
      const selectorsByAddress = new Map(
        onChain.map((f) => [f.address.toLowerCase(), f.selectors as string[]])
      )

      for (const task of tasks) {
        const presentOnChain = resolveFacetPresence(task, routedAddresses)
        // The address is gone while its name is still routed: either a superseded
        // version was just removed, or the snapshot was wrong from the start (a task
        // carrying another network's address, the worldchain/lisk shape). Resolving
        // the second retires the task while the facet it targeted stays live, so no
        // transition is applied and the contradiction is alerted instead.
        if (isSuspectAddressSnapshot(task, routedNames, routedAddresses)) {
          const reason = `parked address ${task.facetAddress} is not routed, but a facet named ${task.facetName} still is — wrong address snapshot? No transition applied`
          consola.warn(
            `[${network}:${environment}] ${task.facetName}: ${reason}`
          )
          anomalies.push({
            network,
            environment,
            facet: task.facetName,
            prUrl: task.prUrl,
            reason,
          })
          continue
        }

        const proposalStatus = await resolveProposalStatus(
          pendingTransactions,
          task.safeTxHash
        )
        const facetDeprecated = isParkedFacetStillRemovable({
          facetName: task.facetName,
          facetAddress: task.facetAddress,
          addressToName,
          expectedNames,
          sourceNames: cachedSourceContractNames(),
          activeSelectors,
          routedSelectors:
            selectorsByAddress.get(task.facetAddress.toLowerCase()) ?? [],
        })
        const decision = reconcileDecision(task, {
          facetPresentOnChain: presentOnChain,
          proposalStatus,
          facetDeprecated,
        })
        consola.info(
          `[${network}:${environment}] ${task.facetName} (${task.status}) → ${decision}`
        )
        // A terminal task whose facet is routed again, yet no longer deprecated, is a
        // deliberate re-add (incident rollback, or a CREATE2 redeploy landing on the
        // same address). Reopening it would queue a Remove for a live facet target
        // state expects to keep, so the reopen is withheld and reported.
        if (
          decision === 'keep' &&
          RESOLVED_STATUSES.includes(task.status) &&
          presentOnChain
        ) {
          const reason =
            facetDeprecated === undefined
              ? `facet is routed again but ${network}:${environment} has no target-state entry — cannot tell a re-add from a false resolution; reopen withheld`
              : `facet is routed again and is not removable (target state expects it, or it routes selectors an expected facet owns) — treated as a deliberate re-add, reopen withheld`
          consola.warn(
            `[${network}:${environment}] ${task.facetName}: ${reason}`
          )
          anomalies.push({
            network,
            environment,
            facet: task.facetName,
            prUrl: task.prUrl,
            reason,
          })
          continue
        }
        if (decision === 'keep') continue

        // Per-task write isolation: a transient queue write must not unwind past the
        // remaining tasks and every (network, environment) group ordered after this
        // one — the abort-the-sweep failure this job was rebuilt to eliminate.
        try {
          if (decision === 'reopen') {
            // Recorded in dry-run too, so the false-resolution alert is visible
            // without --yes; only the Slack send is gated on applying.
            if (!apply || (await reopenResolvedTask(parkedTasks, task._id)))
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
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error)
          consola.warn(
            `[${network}:${environment}] ${task.facetName}: could not apply "${decision}" — leaving the task unchanged: ${reason}`
          )
          failures.push({
            network,
            environment,
            reason: `${task.facetName}: ${decision} write failed — ${reason}`,
          })
          continue
        }
      }
    }
  } finally {
    await safeMongoClient?.close()
  }
  return { reopened, failures, anomalies, routedByNetworkEnv }
}

/** Logs and (when applying) sends the reconcile sweep's alerts. */
async function runReconcileAlerts(
  run: IReconcileRun,
  apply: boolean
): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS
  const send = async (message: string): Promise<void> => {
    if (apply && webhookUrl && isUnattendedRun())
      await new SlackNotifier(webhookUrl).sendNotificationWithRetry({
        text: message,
      })
  }
  if (apply && webhookUrl && !isUnattendedRun())
    consola.info(
      'Local run: reconcile alerts logged only. Set CI=1 to deliver them to Slack.'
    )

  const reopenMessage = formatReopenAlertMessage(run.reopened)
  if (reopenMessage) {
    consola.error(reopenMessage)
    await send(reopenMessage)
  }

  const anomalyMessage = formatReconcileAnomalyMessage(run.anomalies)
  if (anomalyMessage) {
    consola.warn(anomalyMessage)
    await send(anomalyMessage)
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
 *
 * A network the reconcile could not read contributes no routed set; its entries
 * are held back rather than reported prunable against unknown chain state.
 */
async function reportSafeToPrune(
  parkedTasks: Parameters<typeof listParkedTasks>[0],
  networkFilter: string | undefined,
  routedByNetworkEnv: Map<string, Set<string>>
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
  const entries = computeSafeToPrune(
    all,
    (e) => Boolean(logsByKey.get(`${e.network}:${e.environment}`)?.[e.facet]),
    (e) => {
      const routed = routedByNetworkEnv.get(`${e.network}:${e.environment}`)
      if (!routed) return true // unread network — hold the entry back
      const logged = logsByKey.get(`${e.network}:${e.environment}`)?.[e.facet]
      return logged !== undefined && routed.has(logged.toLowerCase())
    }
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
      'WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS is unset, so the TTL alert cannot be delivered. Set the SLACK_WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS repository secret.'
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
    cancelDeprecated: {
      type: 'boolean',
      description:
        'Also cancel queued tasks parked on a network outside the active set in networks.json. Requires --network (a temporarily narrowed config must never be read as a fleet-wide deprecation)',
      required: false,
    },
  },
  async run({ args }) {
    const ttlDays = parseTtlDays(args.ttlDays)
    const apply = args.yes ?? false
    const cancelDeprecated = args.cancelDeprecated ?? false
    if (!apply) consola.info('Dry-run — pass --yes to apply transitions/alert')
    if (cancelDeprecated && !args.network) {
      consola.error(
        '--cancel-deprecated requires --network: name the deprecated network explicitly so a temporarily narrowed networks.json can never cancel the whole queue'
      )
      process.exitCode = 1
      return
    }
    // getParkedTasksCollection reads the un-gated MONGODB_URI cluster (no tunnel).
    getEnvVar('MONGODB_URI')
    const { client, parkedTasks } = await getParkedTasksCollection()
    try {
      // Per-network throws are already contained inside reconcileAll; this guards
      // the sweep as a whole (queue read, network config), because a throw here
      // would otherwise skip both alert paths and the TTL backstop with them.
      let run: IReconcileRun
      try {
        run = await reconcileAll(
          parkedTasks,
          args.network,
          apply,
          cancelDeprecated
        )
      } catch (error: unknown) {
        run = {
          reopened: [],
          failures: [
            {
              network: args.network ?? 'all',
              environment: EnvironmentEnum.production,
              reason: `reconcile sweep aborted: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          anomalies: [],
          routedByNetworkEnv: new Map(),
        }
        consola.error(run.failures[0]?.reason)
      }
      await runReconcileAlerts(run, apply)
      await runTtlAlert(parkedTasks, args.network, ttlDays, apply)
      await reportSafeToPrune(parkedTasks, args.network, run.routedByNetworkEnv)
    } finally {
      await client.close()
    }
  },
})

// Guard so importing the pure decisions (reconcile-parked-tasks.test.ts) does not
// launch the CLI; runs only when executed directly (mirrors list-timelock-queue.ts).
if (import.meta.main) runMain(main)
