/**
 * Deferred diamond-cleanup queue — drain layer.
 *
 * Opportunistically turns parked facet-removal tasks into a governance proposal
 * the next time any facet cut is proposed on a network, so removals ride along at
 * ~zero marginal signing cost instead of firing a dedicated fleet-wide event
 * (design: docs/DeferredDiamondCleanupQueue.md §6). Hooked into the `runPropose`
 * funnel (propose-to-safe.ts) as a best-effort tail: a drain failure must never
 * affect the primary proposal or the process exit code.
 *
 * The pure {@link drainNetwork} orchestration takes every dependency injected
 * (queue reads/transitions, the #2047 removal engine, the proposal mint, and
 * alert/log sinks) so it is fully unit-testable without Mongo, chain, or a Safe
 * client. Only the live adapter ({@link drainParkedTasks} plus its Mongo/Safe
 * wiring) touches out-of-process state, exactly like the store's
 * `getParkedTasksCollection()`.
 *
 * Guardrails (spec §6/§11/§12): flag-gated on `DRAIN_PARKED_TASKS` (default off —
 * ON for rollouts, OFF for emergencies so a break-glass proposal never drags
 * unrelated removals into its signing set), reentrancy-guarded, and a no-op on
 * direct-send environments (staging / testnet / `SEND_PROPOSALS_DIRECTLY_TO_DIAMOND`).
 * The minted removal is byte-for-byte the same governed object `cleanUpProdDiamond`
 * produces (Safe → timelock `scheduleBatch` → quorum); the queue changes only WHEN
 * a proposal is created and WHAT annotation it carries, never HOW it is authorized.
 */

import 'dotenv/config'

import { consola } from 'consola'
import { type WithId } from 'mongodb'
import { getAddress, type Address, type Hex } from 'viem'

import {
  EnvironmentEnum,
  type IProposeToSafeOptions,
  type SupportedChain,
} from '../../common/types'
import { SlackNotifier } from '../../utils/slack-notifier'
import {
  buildDiamondCutRemoveCalldata,
  getContractAddressForNetwork,
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
import {
  getNextNonce,
  getPrivateKey,
  getSafeMongoCollection,
  initializeSafeClient,
  OperationTypeEnum,
  storeTransactionInMongoDB,
  wrapWithTimelockSchedule,
  type IParkedTaskRef,
} from './safe-utils'

/** What a drain did on one network, for logging and assertions. */
export interface IDrainOutcome {
  network: string
  environment: EnvironmentEnum
  /** Facets claimed and carried into the minted removal proposal. */
  proposed: IParkedTaskRef[]
  /** Facets already absent on-chain → marked superseded. */
  superseded: string[]
  /** Facets whose deploy-log entry was pruned but are still routed → kept + alerted. */
  prunedButRouted: IParkedTaskRef[]
  /** Protected facets parked in error → cancelled + alerted. */
  protectedCancelled: string[]
  /** Removals whose claim was lost to a concurrent drain → skipped this run. */
  skippedAlreadyClaimed: string[]
  /** The minted proposal's Safe tx hash, when a proposal was created. */
  safeTxHash?: string
}

/**
 * Injected dependencies for {@link drainNetwork}. The live adapter wires these to
 * the queue collection, the removal engine, the Safe mint, and the log/alert
 * sinks; tests pass fakes.
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
  /** Revert a claimed task to queued (mint failed). */
  revert: (taskKey: string) => Promise<unknown>
  /** Link a claimed task to its minted proposal. */
  linkProposal: (taskKey: string, safeTxHash: string) => Promise<unknown>
  /** Mint ONE consolidated per-network removal proposal; returns its Safe tx hash. */
  mint: (params: {
    removals: IFacetRemoval[]
    parkedTaskRefs: IParkedTaskRef[]
  }) => Promise<string>
  /** Loud, human-visible warning (consola + best-effort Slack). */
  alert: (message: string) => void
  /** Ordinary progress log. */
  log: (message: string) => void
}

/**
 * Drains one network's queued facet-removal tasks into a single consolidated
 * removal proposal (spec §6 drain algorithm). Pure orchestration over injected
 * I/O: partition against the live loupe (gone → supersede, pruned-but-routed →
 * keep + alert, protected → cancel + alert, removable → claim), then mint ONE
 * per-network `scheduleBatch` Remove carrying every claimed facet's origin PR and
 * link each claimed task to it. On mint failure every claimed task is reverted to
 * `queued` and the error is rethrown for the caller's best-effort handler.
 *
 * @param network - Network being drained (lowercased upstream).
 * @param environment - Deployment environment (production in v1).
 * @param deps - Injected queue/engine/mint/log dependencies.
 * @returns A structured record of what was proposed, superseded, cancelled, etc.
 * @throws Re-throws a mint failure after reverting all claimed tasks.
 */
export async function drainNetwork(
  network: string,
  environment: EnvironmentEnum,
  deps: IDrainDeps
): Promise<IDrainOutcome> {
  const outcome: IDrainOutcome = {
    network,
    environment,
    proposed: [],
    superseded: [],
    prunedButRouted: [],
    protectedCancelled: [],
    skippedAlreadyClaimed: [],
  }

  const tasks = await deps.listQueued()
  if (tasks.length === 0) return outcome

  const names = tasks.map((t) => t.facetName)
  const nameToAddress: Record<string, Address> = {}
  for (const t of tasks) nameToAddress[t.facetName] = getAddress(t.facetAddress)

  const result = await deps.computeRemovals(names, nameToAddress)

  const removalByName = new Map(result.removals.map((r) => [r.name, r]))
  const notFound = new Set(result.notFoundOnChain)
  const protectedNames = new Set(result.protectedSkipped)
  const prunedNames = new Set(result.prunedButRouted.map((p) => p.name))

  const claimed: { task: WithId<IParkedTask>; removal: IFacetRemoval }[] = []

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

  if (claimed.length === 0) return outcome

  const parkedTaskRefs: IParkedTaskRef[] = claimed.map(({ task }) => ({
    facet: task.facetName,
    prUrl: task.prUrl,
  }))
  const removals = claimed.map(({ removal }) => removal)

  let safeTxHash: string
  try {
    safeTxHash = await deps.mint({ removals, parkedTaskRefs })
  } catch (error) {
    for (const { task } of claimed) await deps.revert(task.taskKey)
    deps.alert(
      `[${network}] parked-task drain mint failed — reverted ${
        claimed.length
      } task(s) to queued: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    throw error
  }

  outcome.safeTxHash = safeTxHash
  for (const { task } of claimed) {
    await deps.linkProposal(task.taskKey, safeTxHash)
    outcome.proposed.push({ facet: task.facetName, prUrl: task.prUrl })
    deps.log(
      `[${network}] parked cleanup: removing ${task.facetName} (origin PR ${task.prUrl}) → ${safeTxHash}`
    )
  }
  return outcome
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

/** Reentrancy guard: the drain's own mint must never re-trigger a drain. */
let draining = false

/** Opens the queue + wires deps; returned `close` releases the connection. */
export type DrainOpener = () => Promise<{
  close: () => Promise<void>
  deps: IDrainDeps
}>

/**
 * Gate → open → drain → close, with the flag / reentrancy / direct-send guards.
 * The queue open is injected ({@link DrainOpener}) so the guards, the drain flow,
 * and the always-close `finally` are unit-testable without Mongo; the live entry
 * {@link drainParkedTasks} supplies the real opener.
 *
 * @param options - The primary proposal's options (network + signing).
 * @param environment - Deployment environment (production in v1).
 * @param open - Opens the queue collection and builds the live deps.
 */
export async function runDrain(
  options: IProposeToSafeOptions,
  environment: EnvironmentEnum,
  open: DrainOpener
): Promise<void> {
  if (!isDrainEnabled()) return
  if (draining) return
  if (isDirectSendEnv(options.network)) return

  draining = true
  const { close, deps } = await open()
  try {
    const outcome = await drainNetwork(options.network, environment, deps)
    logDrainSummary(outcome)
  } finally {
    draining = false
    await close()
  }
}

/**
 * Live entry point hooked into `runPropose` after the primary proposal. Opens the
 * (ungated) queue, wires the live dependencies and runs {@link runDrain}.
 * Best-effort: callers invoke it as `drainParkedTasks(options).catch(warn)`, and
 * it never rethrows a drain failure (only {@link drainNetwork} does, which the
 * live deps here contain).
 *
 * @param options - The same options the primary proposal used (network + signing).
 */
export async function drainParkedTasks(
  options: IProposeToSafeOptions
): Promise<void> {
  const environment = EnvironmentEnum.production
  await runDrain(options, environment, async () => {
    const { client, parkedTasks } = await getParkedTasksCollection()
    return {
      close: () => client.close(),
      deps: buildLiveDeps(options, environment, parkedTasks),
    }
  })
}

/** Wires {@link IDrainDeps} to the live queue collection, engine, mint and sinks. */
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
    mint: (params) => mintRemovalProposal(options, environment, params),
    alert: (message) => {
      consola.warn(message)
      void sendDrainSlackAlert(message)
    },
    log: (message) => consola.info(message),
  }
}

/**
 * Mints ONE consolidated per-network timelock-wrapped removal proposal via the
 * low-level store (NOT by recursing through `runPropose`), annotated with the
 * origin-PR links. Same signing context as the primary proposal.
 */
async function mintRemovalProposal(
  options: IProposeToSafeOptions,
  environment: EnvironmentEnum,
  {
    removals,
    parkedTaskRefs,
  }: {
    removals: IFacetRemoval[]
    parkedTaskRefs: IParkedTaskRef[]
  }
): Promise<string> {
  const useLedger = options.ledger || false
  const privateKey = useLedger
    ? undefined
    : getPrivateKey('PRIVATE_KEY_PRODUCTION', options.privateKey)
  const ledgerOptions = {
    ledgerLive: options.ledgerLive || false,
    accountIndex: options.accountIndex ? Number(options.accountIndex) : 0,
    derivationPath: options.derivationPath,
  }

  const { safe, chain, safeAddress } = await initializeSafeClient(
    options.network,
    privateKey,
    options.rpcUrl,
    useLedger,
    ledgerOptions
  )
  const senderAddress = safe.account.address

  const diamondAddress = getAddress(
    await getContractAddressForNetwork(
      'LiFiDiamond',
      options.network as SupportedChain,
      environment
    )
  )
  const timelockAddress = getAddress(
    await getContractAddressForNetwork(
      'LiFiTimelockController',
      options.network as SupportedChain,
      environment
    )
  )

  const removalCalldata = buildDiamondCutRemoveCalldata(
    removals.map((r) => ({ name: r.name, selectors: r.selectors }))
  )
  const { calldata, targetAddress } = await wrapWithTimelockSchedule(
    options.network,
    options.rpcUrl || '',
    timelockAddress,
    [diamondAddress],
    [removalCalldata]
  )

  const { client, pendingTransactions } = await getSafeMongoCollection()
  try {
    const nextNonce = await getNextNonce(
      pendingTransactions,
      safeAddress,
      options.network,
      chain.id,
      await safe.getNonce()
    )
    const safeTransaction = await safe.createTransaction({
      transactions: [
        {
          to: targetAddress,
          value: 0n,
          data: calldata as Hex,
          operation: OperationTypeEnum.Call,
          nonce: nextNonce,
        },
      ],
    })
    const signedTx = await safe.signTransaction(safeTransaction)
    const safeTxHash = await safe.getTransactionHash(signedTx)

    const result = await storeTransactionInMongoDB(
      pendingTransactions,
      safeAddress,
      options.network,
      chain.id,
      signedTx,
      safeTxHash as Hex,
      senderAddress as Address,
      parkedTaskRefs
    )
    if (result === null)
      throw new Error(
        'drain removal proposal was not stored (duplicate pending intent) — leaving tasks to retry'
      )
    return safeTxHash
  } finally {
    await client.close()
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
    `[${outcome.network}] parked-task drain: ${proposed.length} proposed, ` +
      `${superseded.length} superseded, ${protectedCancelled.length} cancelled, ` +
      `${prunedButRouted.length} pruned-but-routed (kept)` +
      (outcome.safeTxHash ? ` → ${outcome.safeTxHash}` : '')
  )
}
