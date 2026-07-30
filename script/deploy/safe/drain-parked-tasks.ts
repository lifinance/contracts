/**
 * Deferred diamond-cleanup queue — drain layer (design: docs/DeferredDiamondCleanupQueue.md §6).
 *
 * Folds parked facet-removal tasks into the primary Safe proposal being created on
 * a network — appended as extra inner calls of its timelock `scheduleBatch`, one
 * `diamondCut` Remove per facet — so removals ride along in the same single
 * signature. Hooked into `runPropose` (propose-to-safe.ts) and gated on
 * `DRAIN_PARKED_TASKS` (default off); it no-ops on direct-send / testnet and only
 * folds into a timelock proposal. A drain-only failure must never affect the
 * primary proposal or the process exit code.
 *
 * `prepareDrainNetwork` takes every dependency injected so it is unit-testable
 * without Mongo, chain, or a Safe client; only {@link proposeWithDrain}'s default
 * opener touches out-of-process state.
 */

import 'dotenv/config'

import { consola } from 'consola'
import { type WithId } from 'mongodb'
import { getAddress, type Address, type Hex } from 'viem'

import { EnvironmentEnum, type IProposeToSafeOptions } from '../../common/types'
import { SlackNotifier } from '../../utils/slack-notifier'
import {
  buildDiamondCutRemoveCalldata,
  isTestnetNetwork,
} from '../../utils/viemScriptHelpers'

import {
  computeNamedFacetRemovals,
  type IFacetRemoval,
  type INamedRemovalResult,
} from './diamondRemovalDiff'
import {
  claimForProposal,
  getParkedTasksCollection,
  listParkedTasks,
  markCancelled,
  markSuperseded,
  revertToQueued,
  setSafeTxHash,
  type IParkedTask,
} from './parked-tasks'
import { type IParkedTaskRef } from './safe-utils'

/** A single timelock inner-call to append to the primary `scheduleBatch`. */
export interface ITimelockCall {
  to: Address
  calldata: Hex
}

/** What a drain did on one network, for logging and assertions. */
export interface IDrainOutcome {
  network: string
  environment: EnvironmentEnum
  /** Facets claimed and folded into the primary proposal's removal calls. */
  proposed: IParkedTaskRef[]
  /** Facets already absent on-chain → marked superseded. */
  superseded: string[]
  /** Facets whose deploy-log entry was pruned but are still routed → kept + alerted. */
  prunedButRouted: IParkedTaskRef[]
  /** Protected facets parked in error → cancelled + alerted. */
  protectedCancelled: string[]
  /** Removals whose claim was lost to a concurrent drain → skipped this run. */
  skippedAlreadyClaimed: string[]
  /** The primary proposal's Safe tx hash, once claimed tasks are linked to it. */
  safeTxHash?: string
}

/**
 * The result of {@link prepareDrainNetwork}: the removal calls to append to the
 * primary proposal, the PR links to annotate it with, and the claimed task keys
 * the caller must resolve — link on proposal success, revert on failure.
 */
export interface IDrainPreparation {
  /** One `diamondCut` Remove call per claimed facet (diamond as target). */
  calls: ITimelockCall[]
  /** Origin-PR links carried onto the primary proposal for the signer to see. */
  parkedTaskRefs: IParkedTaskRef[]
  /** Claimed (`queued → proposed`) task keys — link on success, revert on failure. */
  claimedTaskKeys: string[]
  /** Partition side-effects already applied (superseded / cancelled / pruned / skipped). */
  outcome: IDrainOutcome
}

/**
 * Injected dependencies for {@link prepareDrainNetwork}. The live adapter wires
 * these to the queue collection, the removal engine and the log/alert sinks;
 * tests pass fakes.
 */
export interface IDrainDeps {
  /** Queued tasks for this network/environment. */
  listQueued: () => Promise<WithId<IParkedTask>[]>
  /** Resolve requested names against the live loupe, hinting stored addresses (§8). */
  computeRemovals: (
    names: string[],
    nameToAddress: Record<string, Address>
  ) => Promise<INamedRemovalResult>
  /** Atomic queued → proposed flip (dedup gate); `null` if lost the race. */
  claim: (taskKey: string) => Promise<unknown>
  /** Mark a task superseded (facet already gone on-chain). */
  supersede: (taskKey: string) => Promise<unknown>
  /** Cancel a task (protected facet parked in error). */
  cancel: (taskKey: string) => Promise<unknown>
  /** Revert a claimed task to queued (proposal failed or was a duplicate). */
  revert: (taskKey: string) => Promise<unknown>
  /** Link a claimed task to the primary proposal it rode along in. */
  linkProposal: (taskKey: string, safeTxHash: string) => Promise<unknown>
  /** Loud, human-visible warning (consola + best-effort Slack). */
  alert: (message: string) => void
  /** Ordinary progress log. */
  log: (message: string) => void
}

/**
 * Prepares one network's queued facet-removal tasks for folding into the primary
 * proposal (spec §6 drain algorithm). Pure orchestration over injected I/O:
 * partition against the live loupe (gone → supersede, pruned-but-routed → keep +
 * alert, protected → cancel + alert, removable → claim), then build one
 * `diamondCut` Remove call per claimed facet for the caller to append to the
 * primary's `scheduleBatch`. Claiming and calldata-building are wrapped so a
 * mid-preparation failure reverts every task this run already claimed before
 * rethrowing — the caller then proceeds primary-only.
 *
 * Does NOT sign or store anything: the claimed tasks are linked to (or reverted
 * from) the primary proposal by {@link proposeWithDrain} once its Safe tx hash is
 * known.
 *
 * @param network - Network being drained (lowercased upstream).
 * @param environment - Deployment environment (production in v1).
 * @param deps - Injected queue/engine/log dependencies.
 * @returns The removal calls, PR links, claimed task keys and partition outcome.
 * @throws Re-throws a preparation failure after reverting all claimed tasks.
 */
export async function prepareDrainNetwork(
  network: string,
  environment: EnvironmentEnum,
  deps: IDrainDeps
): Promise<IDrainPreparation> {
  const outcome: IDrainOutcome = {
    network,
    environment,
    proposed: [],
    superseded: [],
    prunedButRouted: [],
    protectedCancelled: [],
    skippedAlreadyClaimed: [],
  }
  const empty: IDrainPreparation = {
    calls: [],
    parkedTaskRefs: [],
    claimedTaskKeys: [],
    outcome,
  }

  const tasks = await deps.listQueued()
  if (tasks.length === 0) return empty

  const names = tasks.map((t) => t.facetName)
  const nameToAddress: Record<string, Address> = {}
  for (const t of tasks) nameToAddress[t.facetName] = getAddress(t.facetAddress)

  const result = await deps.computeRemovals(names, nameToAddress)

  const removalByName = new Map(result.removals.map((r) => [r.name, r]))
  const notFound = new Set(result.notFoundOnChain)
  const protectedNames = new Set(result.protectedSkipped)
  const prunedNames = new Set(result.prunedButRouted.map((p) => p.name))

  const claimed: { task: WithId<IParkedTask>; removal: IFacetRemoval }[] = []

  try {
    for (const task of tasks) {
      const name = task.facetName
      const removal = removalByName.get(name)
      if (removal) {
        const won = await deps.claim(task.taskKey)
        if (!won) {
          outcome.skippedAlreadyClaimed.push(name)
          deps.log(
            `[${network}] ${name}: claim lost to a concurrent drain — skipping`
          )
          continue
        }
        claimed.push({ task, removal })
      } else if (notFound.has(name)) {
        await deps.supersede(task.taskKey)
        outcome.superseded.push(name)
        deps.log(`[${network}] ${name}: already absent on-chain — superseded`)
      } else if (prunedNames.has(name)) {
        outcome.prunedButRouted.push({ facet: name, prUrl: task.prUrl })
        deps.alert(
          `[${network}] ${name}: deploy-log entry pruned but address ${task.facetAddress} is still routed — NOT removing. Restore the deploy-log entry, then re-drain. Origin PR: ${task.prUrl}`
        )
      } else if (protectedNames.has(name)) {
        await deps.cancel(task.taskKey)
        outcome.protectedCancelled.push(name)
        deps.alert(
          `[${network}] ${name}: a PROTECTED facet was parked for removal — cancelling (enqueue bug). Origin PR: ${task.prUrl}`
        )
      }
    }

    if (claimed.length === 0) return empty

    // Guaranteed present once there are removals: computeNamedFacetRemovals only
    // omits diamondAddress on the no-diamond early return, which yields no removals.
    const diamondAddress = getAddress(result.diamondAddress as Address)
    const calls: ITimelockCall[] = claimed.map(({ removal }) => ({
      to: diamondAddress,
      calldata: buildDiamondCutRemoveCalldata([
        { name: removal.name, selectors: removal.selectors },
      ]) as Hex,
    }))
    const parkedTaskRefs: IParkedTaskRef[] = claimed.map(({ task }) => ({
      facet: task.facetName,
      prUrl: task.prUrl,
    }))
    const claimedTaskKeys = claimed.map(({ task }) => task.taskKey)

    return { calls, parkedTaskRefs, claimedTaskKeys, outcome }
  } catch (error) {
    for (const { task } of claimed) await deps.revert(task.taskKey)
    deps.alert(
      `[${network}] parked-task drain preparation failed — reverted ${
        claimed.length
      } claimed task(s) to queued: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    throw error
  }
}

/** Whether the opportunistic drain is enabled (spec §6: default OFF, ON for rollouts). */
export function isDrainEnabled(): boolean {
  return process.env.DRAIN_PARKED_TASKS === 'true'
}

/**
 * Whether `network` routes proposals to a direct EOA broadcast rather than the
 * Safe (spec §12 / Fact 13). The queue is a production-mainnet Safe construct, so
 * the drain no-ops here.
 */
export function isDirectSendEnv(network: string): boolean {
  return (
    process.env.SEND_PROPOSALS_DIRECTLY_TO_DIAMOND === 'true' ||
    isTestnetNetwork(network)
  )
}

/**
 * Whether an opportunistic drain should fold into this proposal: the flag is on,
 * the proposal is timelocked (removals need `scheduleBatch` to batch), and the
 * network is a production Safe (not direct-send / testnet).
 */
export function isDrainEligible(options: IProposeToSafeOptions): boolean {
  return (
    isDrainEnabled() &&
    options.timelock === true &&
    !isDirectSendEnv(options.network)
  )
}

/** Reentrancy guard against a `runPropose` that re-enters `runPropose` while a
 * drain is in flight — defensive; the live wiring has no such recursion. */
let draining = false

/** Signs + stores the primary proposal, optionally with appended removal calls. */
export type ProposePrimary = (
  extraTimelockCalls: ITimelockCall[],
  parkedTaskRefs?: IParkedTaskRef[]
) => Promise<{ safeTxHash: Hex; stored: boolean }>

/** Opens the queue + wires deps; returned `close` releases the connection. */
export type DrainOpener = () => Promise<{
  close: () => Promise<void>
  deps: IDrainDeps
}>

/**
 * Runs the primary proposal, folding any parked facet-removal tasks into its
 * `scheduleBatch` so removals ride along in the same single signature (spec §6).
 *
 * Flow: gate (flag / timelock / direct-send / reentrancy) → open the queue →
 * {@link prepareDrainNetwork} (partition + claim + build removal calls) → hand
 * those calls to `proposePrimary` → link each claimed task to the resulting Safe
 * tx hash (or revert them if the primary threw, or was a duplicate that created
 * no new proposal). Best-effort by construction: if the gate is closed, the queue
 * cannot be opened, or preparation fails, the primary is proposed alone and its
 * result returned unchanged — a drain problem never blocks the primary. A genuine
 * primary failure is surfaced (rethrown) after the claimed tasks are reverted.
 *
 * @param options - The primary proposal's options (network + signing + timelock).
 * @param proposePrimary - Signs + stores the primary proposal with the given
 *   appended removal calls and PR links; returns its Safe tx hash and whether a
 *   new proposal was stored (false = duplicate pending intent).
 * @param open - Opens the queue collection and builds the live deps (injected for
 *   tests; defaults to the live Mongo adapter).
 * @returns The primary proposal's result.
 * @throws Re-throws a genuine primary-proposal failure (after releasing any
 *   claimed tasks). Drain-only failures are swallowed, never rethrown.
 */
export async function proposeWithDrain(
  options: IProposeToSafeOptions,
  proposePrimary: ProposePrimary,
  open?: DrainOpener
): Promise<{ safeTxHash: Hex; stored: boolean }> {
  const environment = EnvironmentEnum.production
  if (!isDrainEligible(options)) return proposePrimary([])
  if (draining) return proposePrimary([])

  draining = true
  try {
    const opener = open ?? liveOpener(options, environment)
    let queue: Awaited<ReturnType<DrainOpener>>
    try {
      queue = await opener()
    } catch (error) {
      consola.warn(
        'parked-task drain: could not open the queue (primary proposal unaffected):',
        error
      )
      return proposePrimary([])
    }

    try {
      let prep: IDrainPreparation
      try {
        prep = await prepareDrainNetwork(
          options.network,
          environment,
          queue.deps
        )
      } catch (error) {
        consola.warn(
          'parked-task drain: preparation failed (primary proposal unaffected):',
          error
        )
        return proposePrimary([])
      }

      const refs =
        prep.parkedTaskRefs.length > 0 ? prep.parkedTaskRefs : undefined

      let result: { safeTxHash: Hex; stored: boolean }
      try {
        result = await proposePrimary(prep.calls, refs)
      } catch (error) {
        // The primary itself failed — surface it, but first release the claims we
        // took. Per-key so one failed revert can't drop the primary's error.
        for (const key of prep.claimedTaskKeys)
          await revertQuietly(queue.deps, key)
        throw error
      }

      // The primary is signed and stored; linking the claimed tasks is bookkeeping
      // that must never fail the process (spec §6 best-effort). A link failure
      // leaves the task `proposed` for the reconcile backlog / loupe self-heal.
      try {
        await finalizeClaimed(prep, result, queue.deps)
        logDrainSummary(prep.outcome)
      } catch (error) {
        consola.warn(
          'parked-task drain: linking claimed tasks failed (primary proposal already stored — unaffected):',
          error
        )
      }
      return result
    } finally {
      await queue.close()
    }
  } finally {
    draining = false
  }
}

/**
 * Resolves the claimed tasks against the primary proposal's outcome: on a freshly
 * stored proposal, link each to its Safe tx hash and record it as proposed; on a
 * duplicate (no new proposal), revert them to queued so the next drain re-folds
 * them cleanly.
 */
async function finalizeClaimed(
  prep: IDrainPreparation,
  result: { safeTxHash: Hex; stored: boolean },
  deps: IDrainDeps
): Promise<void> {
  if (prep.claimedTaskKeys.length === 0) return

  if (!result.stored) {
    for (const key of prep.claimedTaskKeys) await revertQuietly(deps, key)
    deps.log(
      `[${prep.outcome.network}] primary proposal already existed (duplicate) — ` +
        `returned ${prep.claimedTaskKeys.length} parked removal(s) to queued`
    )
    return
  }

  // Link per-key: one failed link must not skip the rest, and a claimed task
  // must NOT be reverted here — its removal is already in the stored proposal, so
  // re-queuing it would double-fold it into a future proposal.
  for (const key of prep.claimedTaskKeys)
    try {
      await deps.linkProposal(key, result.safeTxHash)
    } catch (error) {
      deps.alert(
        `[${prep.outcome.network}] could not link parked task ${key} to ${result.safeTxHash} ` +
          `(proposal already stored) — leaving it 'proposed' for reconcile: ${
            error instanceof Error ? error.message : String(error)
          }`
      )
    }
  prep.outcome.safeTxHash = result.safeTxHash
  prep.outcome.proposed = prep.parkedTaskRefs
  for (const ref of prep.parkedTaskRefs)
    deps.log(
      `[${prep.outcome.network}] parked cleanup: removing ${ref.facet} ` +
        `(origin PR ${ref.prUrl}) → ${result.safeTxHash}`
    )
}

/** Reverts a claimed task to queued, swallowing errors so one failure never
 * aborts a cleanup loop or masks a more important error. */
async function revertQuietly(deps: IDrainDeps, taskKey: string): Promise<void> {
  try {
    await deps.revert(taskKey)
  } catch (error) {
    deps.alert(
      `could not revert parked task ${taskKey} to queued: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

/** Builds the live opener: the real queue collection + Mongo-backed deps. */
function liveOpener(
  options: IProposeToSafeOptions,
  environment: EnvironmentEnum
): DrainOpener {
  return async () => {
    const { client, parkedTasks } = await getParkedTasksCollection()
    return {
      close: () => client.close(),
      deps: buildLiveDeps(options, environment, parkedTasks),
    }
  }
}

/** Wires {@link IDrainDeps} to the live queue collection, engine and sinks. */
function buildLiveDeps(
  options: IProposeToSafeOptions,
  environment: EnvironmentEnum,
  parkedTasks: Parameters<typeof listParkedTasks>[0]
): IDrainDeps {
  return {
    listQueued: () =>
      listParkedTasks(parkedTasks, {
        network: options.network,
        status: 'queued',
      }),
    computeRemovals: (names, nameToAddress) =>
      computeNamedFacetRemovals(
        options.network,
        environment,
        names,
        {},
        nameToAddress
      ),
    claim: (taskKey) => claimForProposal(parkedTasks, taskKey),
    supersede: (taskKey) => markSuperseded(parkedTasks, taskKey),
    cancel: (taskKey) => markCancelled(parkedTasks, taskKey),
    revert: (taskKey) => revertToQueued(parkedTasks, taskKey),
    linkProposal: (taskKey, safeTxHash) =>
      setSafeTxHash(parkedTasks, taskKey, safeTxHash),
    alert: (message) => {
      consola.warn(message)
      void sendDrainSlackAlert(message)
    },
    log: (message) => consola.info(message),
  }
}

/** Best-effort Slack alert to the multisig-proposals channel; never throws. */
async function sendDrainSlackAlert(message: string): Promise<void> {
  const webhookUrl = process.env.WEBHOOK_DEV_SC_MULTISIG_PROPOSALS
  if (!webhookUrl) return
  try {
    await new SlackNotifier(webhookUrl).sendNotificationWithRetry({
      text: `⚠️ Deferred diamond-cleanup drain: ${message}`,
    })
  } catch (error) {
    consola.warn('Slack drain alert failed (non-fatal):', error)
  }
}

/** Human-readable one-line summary of a drain run. */
function logDrainSummary(outcome: IDrainOutcome): void {
  const { proposed, superseded, protectedCancelled, prunedButRouted } = outcome
  if (
    proposed.length === 0 &&
    superseded.length === 0 &&
    protectedCancelled.length === 0 &&
    prunedButRouted.length === 0
  ) {
    consola.info(`[${outcome.network}] parked-task drain: nothing to do`)
    return
  }
  consola.success(
    `[${outcome.network}] parked-task drain: ${proposed.length} folded in, ` +
      `${superseded.length} superseded, ${protectedCancelled.length} cancelled, ` +
      `${prunedButRouted.length} pruned-but-routed (kept)` +
      (outcome.safeTxHash ? ` → ${outcome.safeTxHash}` : '')
  )
}
