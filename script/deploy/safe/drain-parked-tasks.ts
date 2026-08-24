/**
 * Deferred diamond-cleanup queue — drain layer (design: docs/DeferredDiamondCleanupQueue.md §6).
 *
 * Folds parked facet-removal tasks into the primary Safe proposal being created on
 * a network — appended as extra inner calls of its timelock `scheduleBatch`, one
 * `diamondCut` Remove per facet — so removals ride along in the same single
 * signature. Hooked into `runPropose` (propose-to-safe.ts) and gated on
 * `DRAIN_PARKED_TASKS` (default off); it no-ops on direct-send / testnet and only
 * folds into a timelock proposal. A drain-only failure must never affect the
 * primary proposal or the process exit code — but that isolation holds only until
 * the proposal is stored: once folded, the removals execute atomically inside the
 * primary's `scheduleBatch`, so a removal that reverts on-chain during the timelock
 * window reverts the primary cut too (§6 TOCTOU tradeoff).
 *
 * `prepareDrainNetwork` takes every dependency injected so it is unit-testable
 * without Mongo, chain, or a Safe client; only {@link proposeWithDrain}'s default
 * opener touches out-of-process state.
 */

import 'dotenv/config'

import { consola } from 'consola'
import { type WithId } from 'mongodb'
import { getAddress, isAddress, type Address, type Hex } from 'viem'

import { EnvironmentEnum, type IProposeToSafeOptions } from '../../common/types'
import { SlackNotifier } from '../../utils/slack-notifier'
import {
  buildDiamondCutRemoveCalldata,
  isTestnetNetwork,
} from '../../utils/viemScriptHelpers'

import {
  computeFacetRemovalsByAddress,
  type IAddressRemovalResult,
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
  /** Protected facets parked in error → cancelled + alerted. */
  protectedCancelled: string[]
  /** Facets whose parked address is unrouted while their NAME still is → left queued + alerted. */
  suspectSnapshots: string[]
  /** Facets whose removability could not be verified → left queued + alerted. */
  unverifiable: string[]
  /** Facets whose parked address target state still expects (wrong snapshot) → left queued + alerted. */
  stillExpected: string[]
  /** Facets whose loupe-resolved deploy-log name disagrees with the parked label → left queued + alerted. */
  nameMismatch: string[]
  /** Tasks whose stored facetAddress is not a valid EVM address → left queued + alerted. */
  invalidAddresses: string[]
  /** Second and later tasks sharing one facet address → left queued + alerted. */
  duplicateAddresses: string[]
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
  /** Partition side-effects already applied (superseded / cancelled / skipped). */
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
  /**
   * Already-claimed (`proposed`) tasks for this network/environment — their
   * addresses seed the duplicate guard, since a pending proposal already carries
   * their Remove and folding it again would revert the batch.
   */
  listProposed: () => Promise<WithId<IParkedTask>[]>
  /** Resolve the parked facet addresses against the live loupe. */
  computeRemovals: (addresses: Address[]) => Promise<IAddressRemovalResult>
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
 * partition against the live loupe (gone → supersede, protected → cancel +
 * alert, removable → claim), then build one `diamondCut` Remove call per claimed
 * facet for the caller to append to the primary's `scheduleBatch`. Claiming and
 * calldata-building are wrapped so a mid-preparation failure reverts every task
 * this run already claimed before rethrowing — the caller then proceeds
 * primary-only.
 *
 * Every task is matched to the loupe by its stored `facetAddress`, never by name:
 * a superseded facet is routinely co-registered with its successor under one
 * deploy-log name, and matching by name would fold the LIVE facet's selectors
 * into the removal (EXSC-750/EXSC-775).
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
    protectedCancelled: [],
    suspectSnapshots: [],
    unverifiable: [],
    stillExpected: [],
    nameMismatch: [],
    invalidAddresses: [],
    duplicateAddresses: [],
    skippedAlreadyClaimed: [],
  }
  const empty: IDrainPreparation = {
    calls: [],
    parkedTaskRefs: [],
    claimedTaskKeys: [],
    outcome,
  }

  const allQueued = await deps.listQueued()
  if (allQueued.length === 0) return empty

  // Enqueue refuses non-EVM addresses, but a legacy row may still carry one; a
  // single such row must not abort the whole network's drain via getAddress.
  const tasks: WithId<IParkedTask>[] = []
  for (const task of allQueued)
    if (isAddress(task.facetAddress, { strict: false })) tasks.push(task)
    else {
      outcome.invalidAddresses.push(task.facetName)
      deps.alert(
        `[${network}] ${task.facetName}: stored facetAddress "${task.facetAddress}" is not a valid EVM address — the drain cannot process it. Cancel it (bunx tsx script/deploy/safe/cancel-parked-task.ts --taskKey "${task.taskKey}" --yes) and re-enqueue with the correct address. Origin PR: ${task.prUrl}`
      )
    }
  if (tasks.length === 0) return empty

  const result = await deps.computeRemovals(
    tasks.map((t) => getAddress(t.facetAddress))
  )

  // No chain read happened, so nothing is known to be absent. Superseding here
  // would retire every queued task for the network — while every facet is still
  // routed — on nothing but a deploy log missing its LiFiDiamond key.
  if (result.diamondUnresolved) {
    deps.alert(
      `[${network}] parked-task drain skipped: no LiFiDiamond resolved for ${environment} — ${tasks.length} task(s) left queued (deploy log incomplete?)`
    )
    return empty
  }

  const lower = (address: string): string => address.toLowerCase()
  const removalByAddress = new Map(
    result.removals.map((r) => [lower(r.address), r])
  )
  const notFound = new Set(result.notFoundOnChain.map(lower))
  const protectedAddresses = new Set(
    result.protectedSkipped.map((p) => lower(p.address))
  )
  // Deliberately NOT folded into protectedAddresses: that set cancels the task
  // (terminal, "parked in error"), while an unverifiable address only means a
  // selector union could not be built — a tooling gap that must leave the
  // task queued for the next run.
  const unverifiableAddresses = new Set(result.unverifiable.map(lower))
  const stillExpectedByAddress = new Map(
    result.stillExpected.map((s) => [lower(s.address), s])
  )

  const claimed: {
    task: WithId<IParkedTask>
    removal: { selectors: `0x${string}`[] }
  }[] = []

  // Seeded with already-claimed (proposed) addresses: their Remove is already in
  // a pending proposal, and a legacy row keyed by facet NAME does not collide
  // with a re-enqueue of the same address in the unique index — folding the same
  // Remove into a second batch makes whichever executes second revert, taking
  // its whole `scheduleBatch` (primary proposal included) with it.
  const claimedAddresses = new Set(
    (await deps.listProposed())
      .map((t) => lower(t.facetAddress))
      .filter((a) => a.startsWith('0x'))
  )

  try {
    for (const task of tasks) {
      const name = task.facetName
      const address = lower(task.facetAddress)
      const removal = removalByAddress.get(address)
      const stillExpected = stillExpectedByAddress.get(address)
      if (removal) {
        if (claimedAddresses.has(address)) {
          outcome.duplicateAddresses.push(name)
          deps.alert(
            `[${network}] ${name} (${task.facetAddress}): another open task already carries this address — folding it in twice would revert the batch, so it stays queued. Cancel the duplicate (bunx tsx script/deploy/safe/cancel-parked-task.ts --taskKey "${task.taskKey}" --yes), then run \`bunx tsx script/deploy/safe/migrate-parked-task-keys.ts --apply\` to normalise legacy keys. If the other task is already \`proposed\`, this drain merely raced a concurrent one — no action needed. Origin PR: ${task.prUrl}`
          )
          continue
        }
        // The engine resolved this address off the loupe; if the deploy log names
        // it differently than the task's label, the snapshot points at another
        // facet than the one the operator parked — never remove on a contradiction.
        if (removal.name !== undefined && removal.name !== task.facetName) {
          outcome.nameMismatch.push(name)
          deps.alert(
            `[${network}] ${name} (${task.facetAddress}): the deploy log names this address ${removal.name} — the parked label and the address disagree, so this is a wrong snapshot. Refusing to remove; cancel the task (bunx tsx script/deploy/safe/cancel-parked-task.ts --taskKey "${task.taskKey}" --yes) and re-enqueue with the right address. Origin PR: ${task.prUrl}`
          )
          continue
        }
        const won = await deps.claim(task.taskKey)
        // Recorded even when the claim was lost: the winning drain is folding
        // this address into ITS proposal, so a second task carrying the same
        // address must not be claimed by this run either.
        claimedAddresses.add(address)
        if (!won) {
          outcome.skippedAlreadyClaimed.push(name)
          deps.log(
            `[${network}] ${name}: claim lost to a concurrent drain — skipping`
          )
          continue
        }
        claimed.push({ task, removal })
      } else if (stillExpected !== undefined) {
        outcome.stillExpected.push(name)
        deps.alert(
          `[${network}] ${name} (${task.facetAddress}): refusing to remove — ${stillExpected.reason}. The parked address points at a LIVE facet (wrong snapshot?); cancel the task (bunx tsx script/deploy/safe/cancel-parked-task.ts --taskKey "${task.taskKey}" --yes) and re-enqueue with the right address. Origin PR: ${task.prUrl}`
        )
      } else if (notFound.has(address)) {
        // An address can be absent because the facet really was removed, or because
        // the snapshot was wrong from the start (a task carrying another network's
        // address). Superseding the second case retires the task while the facet it
        // was meant to remove stays routed, so a name still on the diamond keeps the
        // task open for a human — the same guard the reconcile applies.
        if (result.routedNames.has(name)) {
          outcome.suspectSnapshots.push(name)
          deps.alert(
            `[${network}] ${name} (${task.facetAddress}): parked address is NOT routed, but a facet named ${name} still is — refusing to supersede. Adjudicate: if the origin PR parked another network's address, re-enqueue with this network's and cancel this task; if the facet was removed out-of-band, cancel it. Until then it stays queued and this alert repeats. Origin PR: ${task.prUrl}`
          )
          continue
        }
        await deps.supersede(task.taskKey)
        outcome.superseded.push(name)
        deps.log(
          `[${network}] ${name} (${task.facetAddress}): already absent on-chain — superseded`
        )
      } else if (protectedAddresses.has(address)) {
        await deps.cancel(task.taskKey)
        outcome.protectedCancelled.push(name)
        deps.alert(
          `[${network}] ${name} (${task.facetAddress}): a PROTECTED facet was parked for removal — cancelling (enqueue bug). Origin PR: ${task.prUrl}`
        )
      } else if (unverifiableAddresses.has(address)) {
        outcome.unverifiable.push(name)
        deps.alert(
          `[${network}] ${name} (${task.facetAddress}): cannot verify removability — the network has no target-state entry, or the selector unions are unavailable (run \`forge build\`) — leaving it queued. Origin PR: ${task.prUrl}`
        )
      }
    }

    if (claimed.length === 0) return empty

    // Guaranteed present once there are removals: computeFacetRemovalsByAddress only
    // omits diamondAddress on the no-diamond early return, which yields no removals.
    const diamondAddress = getAddress(result.diamondAddress as Address)
    const calls: ITimelockCall[] = claimed.map(({ task, removal }) => ({
      to: diamondAddress,
      calldata: buildDiamondCutRemoveCalldata([
        { name: task.facetName, selectors: removal.selectors },
      ]) as Hex,
    }))
    const parkedTaskRefs: IParkedTaskRef[] = claimed.map(({ task }) => ({
      facet: task.facetName,
      prUrl: task.prUrl,
    }))
    const claimedTaskKeys = claimed.map(({ task }) => task.taskKey)

    return { calls, parkedTaskRefs, claimedTaskKeys, outcome }
  } catch (error) {
    // Per-key so one failed revert neither strands the other claims nor masks
    // the original preparation error we're about to rethrow.
    for (const { task } of claimed) await revertQuietly(deps, task.taskKey)
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
      // Best-effort: a failed connection close must not surface as a primary-proposal
      // failure once the proposal is already signed and stored.
      try {
        await queue.close()
      } catch (error) {
        consola.warn(
          'parked-task drain: queue close failed (non-fatal):',
          error
        )
      }
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
        environment,
        status: 'queued',
      }),
    listProposed: () =>
      listParkedTasks(parkedTasks, {
        network: options.network,
        environment,
        status: 'proposed',
      }),
    computeRemovals: (addresses) =>
      computeFacetRemovalsByAddress(options.network, environment, addresses),
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
  const {
    proposed,
    superseded,
    protectedCancelled,
    suspectSnapshots,
    unverifiable,
    stillExpected,
    nameMismatch,
    invalidAddresses,
    duplicateAddresses,
  } = outcome
  // Refusals are counted, not just alerted: a run that left every queued task
  // untouched must never summarise as "nothing to do".
  const refused =
    suspectSnapshots.length +
    unverifiable.length +
    stillExpected.length +
    nameMismatch.length +
    invalidAddresses.length +
    duplicateAddresses.length
  if (
    proposed.length === 0 &&
    superseded.length === 0 &&
    protectedCancelled.length === 0 &&
    refused === 0
  ) {
    consola.info(`[${outcome.network}] parked-task drain: nothing to do`)
    return
  }
  consola.success(
    `[${outcome.network}] parked-task drain: ${proposed.length} folded in, ` +
      `${superseded.length} superseded, ${protectedCancelled.length} cancelled, ` +
      `${refused} left queued (${suspectSnapshots.length} suspect snapshot, ` +
      `${unverifiable.length} unverifiable, ${stillExpected.length} still expected, ` +
      `${nameMismatch.length} name mismatch, ${invalidAddresses.length} invalid address, ` +
      `${duplicateAddresses.length} duplicate address)` +
      (outcome.safeTxHash ? ` → ${outcome.safeTxHash}` : '')
  )
}
