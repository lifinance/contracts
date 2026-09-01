#!/usr/bin/env bun

/**
 * Execute Pending Timelock Transactions
 *
 * This script executes pending transactions in the LiFiTimelockController where the timelock period has passed.
 * It uses viem to interact with the blockchain and citty for command line argument parsing.
 */

import 'dotenv/config'

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { defineCommand, runMain } from 'citty'
import { consola } from 'consola'
import type { Collection, UpdateFilter } from 'mongodb'
import type { Address, Hex, PublicClient } from 'viem'
import { encodeFunctionData, formatEther, parseAbi } from 'viem'

import data from '../../../config/networks.json'
import {
  EnvironmentEnum,
  type IChainCaller,
  type INetworksObject,
  type SupportedChain,
} from '../../common/types'
import { setupEnvironment } from '../../demoScripts/utils/demoScriptHelpers'
import { sleep } from '../../utils/delay'
import { getDeployments } from '../../utils/deploymentHelpers'
import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'
import {
  isUnattendedRun,
  SlackNotifier,
  type INetworkResult,
  type IProcessingStats,
} from '../../utils/slack-notifier'

import { confirmTimelockExecution } from './confirm-timelock-execution'
import {
  buildRemovalSnapshotFromPayloads,
  describeStaleRemovals,
  mapLoupeResult,
  revalidateRemovalsOnChain,
} from './diamondRemovalDiff'
import { createChainCaller } from './executors/create-chain-caller'
import {
  getParkedTasksCollection,
  listParkedTasksBySafeTxHash,
} from './parked-tasks'
import { formatTimelockScheduleBatch } from './safe-decode-utils'
import {
  classifyPrefetchResults,
  fetchPendingForNetworks,
} from './timelock-prefetch'
import {
  byOperationId,
  classifyBlockedRow,
  computeOperationIdBatch,
  deserializeScheduleParams,
  getTimelockQueueCollection,
  markTimelockOpBlocked,
  markTimelockOpFailedInQueue,
  recordTimelockOpRevert,
  REVERT_BLOCK_THRESHOLD,
  selectBlockedNeedingAlert,
  shouldBlockAfterRevert,
  staleStatusMetadataUnset,
  type IBlockedOpCandidate,
  type ITimelockQueueDoc,
} from './timelock-queue'

// TimelockController ABI for the functions we need
const TIMELOCK_ABI = parseAbi([
  'function getMinDelay() view returns (uint256)',
  'function getTimestamp(bytes32 id) view returns (uint256)',
  'function isOperation(bytes32 id) view returns (bool)',
  'function isOperationPending(bytes32 id) view returns (bool)',
  'function isOperationReady(bytes32 id) view returns (bool)',
  'function isOperationDone(bytes32 id) view returns (bool)',
  'function execute(address target, uint256 value, bytes calldata payload, bytes32 predecessor, bytes32 salt) payable returns (bytes)',
  'function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable returns (bytes[])',
  'function cancel(bytes32 id)',
  'event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)',
  'event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)',
  'event CallSalt(bytes32 indexed id, bytes32 salt)',
  'event Cancelled(bytes32 indexed id)',
])

// Define the operation type (single call or batch)
interface ITimelockOperation {
  id: Hex
  index: bigint
  predecessor: Hex
  delay: bigint
  salt?: Hex
  functionName?: string | null
  /** Originating Safe tx hash, kept for traceability in logs and Slack alerts. */
  safeTxHash?: string
  /** Call list (always present; batch-of-one for single-call ops). */
  targets: readonly Address[]
  values: readonly bigint[]
  payloads: readonly Hex[]
}

// Define the command
const cmd = defineCommand({
  meta: {
    name: 'execute-pending-timelock-tx',
    description:
      'Execute pending timelock transactions where the timelock period has passed',
  },
  args: {
    network: {
      type: 'string',
      description:
        'Network to execute transactions on (default: all active networks)',
      required: false,
    },
    dryRun: {
      type: 'boolean',
      description: 'Simulate transactions without sending them',
      required: false,
      default: false,
    },
    operationId: {
      type: 'string',
      description: 'Specific operation ID to execute (optional)',
      required: false,
    },
    executeAll: {
      type: 'boolean',
      description:
        'Auto execute all pending timelock transactions without prompts',
      required: false,
      default: false,
    },
    rejectAll: {
      type: 'boolean',
      description:
        'Auto cancel/reject all pending timelock transactions without prompts',
      required: false,
      default: false,
    },
    rpcUrl: {
      type: 'string',
      description: 'Override RPC URL for the network',
      required: false,
    },
    notify: {
      type: 'string',
      description:
        'Slack webhook URL for sending notifications (only used with --executeAll)',
      required: false,
    },
  },
  async run({ args }) {
    // setupEnvironment handles private key management internally based on environment
    const isDryRun = Boolean(args?.dryRun)
    const specificOperationId = args?.operationId as Hex | undefined
    const executeAll = Boolean(args?.executeAll)
    const rejectAll = Boolean(args?.rejectAll)
    const rpcUrlOverride = args?.rpcUrl
    const notifyWebhook = args?.notify

    // Validate conflicting flags
    if (executeAll && rejectAll) {
      consola.error(
        '❌ Cannot use both --executeAll and --rejectAll flags together'
      )
      process.exit(1)
    }

    if (rpcUrlOverride && !args?.network) {
      consola.error('❌ --rpc-url can only be used with --network')
      process.exit(1)
    }

    // Validate notify flag
    if (notifyWebhook && !executeAll) {
      consola.error('❌ --notify flag can only be used with --executeAll')
      process.exit(1)
    }

    // Initialize Slack notifier if webhook URL provided
    let slackNotifier: SlackNotifier | undefined
    if (notifyWebhook)
      try {
        new URL(notifyWebhook) // Validate webhook URL format
        // In CI the workflow exports a deep-link to the running job; when present
        // it is surfaced in failure/summary notifications so on-call can jump
        // straight to the failing logs. Absent for local runs.
        slackNotifier = new SlackNotifier(
          notifyWebhook,
          process.env.TIMELOCK_RUN_URL
        )
        consola.info('📢 Slack notifications enabled')
      } catch (error) {
        consola.error('❌ Invalid Slack webhook URL provided')
        process.exit(1)
      }

    // Log execution mode
    if (isDryRun)
      consola.info('🔍 Running in DRY RUN mode - no transactions will be sent')

    if (executeAll)
      consola.info(
        '🚀 AUTO EXECUTE mode - all pending operations will be executed automatically'
      )

    if (rejectAll)
      consola.info(
        '❌ AUTO REJECT mode - all pending operations will be cancelled automatically'
      )

    // Load networks configuration
    const networksConfig = data as INetworksObject

    // Filter networks based on command line argument or use all active networks
    let networksToProcess: INetworksObject[string][] = []
    if (args?.network) {
      const network = networksConfig[args.network.toLowerCase()]
      if (!network) {
        consola.error(`❌ Network '${args.network}' not found in configuration`)
        process.exit(1)
      }
      networksToProcess = [network]
    }
    // Use all active networks
    else
      networksToProcess = Object.values(networksConfig).filter(
        (network) => network.status === 'active'
      )

    consola.info(
      `🔍 Processing ${networksToProcess.length} network${
        networksToProcess.length === 1 ? '' : 's'
      }${args?.network ? ` (${args.network})` : ''}`
    )

    if (isDryRun)
      consola.info('Running in DRY RUN mode - no transactions will be sent')

    // The prefetch is queue-only over a single MongoDB connection; processNetwork
    // then opens a fresh RPC per network so execution never reuses a connection
    // that idled through a long interactive pause.
    if (executeAll || rejectAll) {
      consola.info('🚀 Checking all networks for pending operations...')

      const { networks: networksWithWork, failedCount: prefetchFailures } =
        await prefetchNetworksWithPendingOps(networksToProcess)
      if (networksWithWork.length === 0) return

      consola.info(
        'Processing networks with queued or blocked ops (fresh RPC per network).'
      )

      const results = await Promise.all(
        networksWithWork.map((network) =>
          processNetwork(
            network,
            isDryRun,
            specificOperationId,
            executeAll,
            rejectAll,
            rpcUrlOverride,
            slackNotifier
          )
        )
      )

      // Log summary
      const successfulNetworks = results.filter((r) => r.success).length
      const failedNetworks = results.filter((r) => !r.success).length
      const totalOperationsProcessed = results.reduce(
        (sum, r) => sum + (r.operationsProcessed || 0),
        0
      )
      const totalOperationsFailed = results.reduce(
        (sum, r) => sum + (r.operationsFailed || 0),
        0
      )
      const totalOperationsSucceeded = results.reduce(
        (sum, r) => sum + (r.operationsSucceeded || 0),
        0
      )

      consola.info(`\n📊 Parallel execution summary:`)
      consola.info(`   ✅ Successful networks: ${successfulNetworks}`)
      consola.info(`   ❌ Failed networks: ${failedNetworks}`)
      consola.info(`   📋 Total networks processed: ${results.length}`)
      consola.info(
        `   📝 Total operations processed: ${totalOperationsProcessed}`
      )
      consola.info(
        `   ✅ Total operations succeeded: ${totalOperationsSucceeded}`
      )
      if (totalOperationsFailed > 0)
        consola.error(`   ❌ Total operations failed: ${totalOperationsFailed}`)

      // Send batch summary notification if Slack is enabled AND there were
      // operations, op-level failures, or any network-level failures (e.g. a
      // network erroring before reaching the per-op loop, which leaves
      // operationsFailed=0 but failedNetworks>0).
      const hasWork =
        totalOperationsProcessed > 0 ||
        totalOperationsFailed > 0 ||
        failedNetworks > 0
      if (slackNotifier && hasWork)
        try {
          await slackNotifier.notifyBatchSummary(results)
        } catch (error) {
          consola.warn('Failed to send batch summary notification:', error)
        }

      // Exit with error code if there were failures. A network the prefetch
      // could not check counts: it was never looked at, and having found work
      // elsewhere does not make that safe to pass over silently.
      if (
        failedNetworks > 0 ||
        totalOperationsFailed > 0 ||
        prefetchFailures > 0
      ) {
        if (prefetchFailures > 0)
          consola.error(
            `   ❌ Networks never checked (prefetch failed): ${prefetchFailures}`
          )
        consola.error('\n❌ Script completed with errors')
        process.exit(1)
      }
    } else {
      consola.info('🔄 Checking all networks for pending operations...')

      const { networks: networksWithWork, failedCount: prefetchFailures } =
        await prefetchNetworksWithPendingOps(networksToProcess)
      if (networksWithWork.length === 0) return

      consola.info(
        'Processing networks with queued or blocked ops sequentially (fresh RPC per network).'
      )

      let totalFailed = 0
      let totalSucceeded = 0

      for (const network of networksWithWork)
        try {
          const result = await processNetwork(
            network,
            isDryRun,
            specificOperationId,
            executeAll,
            rejectAll,
            rpcUrlOverride,
            undefined // No Slack notifier in sequential mode
          )

          if (result.success) totalSucceeded++
          else totalFailed++

          if (result.operationsFailed && result.operationsFailed > 0)
            consola.error(
              `[${result.network}] ❌ ${result.operationsFailed} operation(s) failed`
            )
        } catch (error) {
          consola.error(`Error processing network ${network.name}:`, error)
          totalFailed++
        }

      // A network the prefetch could not check was never looked at; finding work
      // elsewhere does not make passing over it safe, so it fails the run too.
      if (totalFailed > 0 || prefetchFailures > 0) {
        consola.error(
          `\n❌ Script completed with ${totalFailed} network(s) having failures${
            prefetchFailures > 0
              ? ` and ${prefetchFailures} network(s) never checked (prefetch failed)`
              : ''
          }`
        )
        process.exit(1)
      } else
        consola.success(
          `\n✅ All ${totalSucceeded} network(s) processed successfully`
        )
    }
  },
})

/**
 * Checks the status of an operation in the LiFiTimelockController.
 *
 * On Tron the three readContract calls run sequentially with an inter-call
 * delay; TronGrid caps the API key at 15 req/s and a single Promise.all here
 * combined with the per-row loop bursts past that and trips a 25-second penalty.
 */
async function checkOperationStatus(
  publicClient: PublicClient,
  timelockAddress: Address,
  operationId: Hex,
  networkName: string
): Promise<{
  isDone: boolean
  isPending: boolean
  isReady: boolean
}> {
  if (isTronNetworkKey(networkName)) {
    const isDone = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationDone',
      args: [operationId],
    })
    await sleep(2000) // 2 s — TronGrid 15 req/s cap needs generous spacing
    const isPending = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationPending',
      args: [operationId],
    })
    await sleep(2000) // 2 s — TronGrid 15 req/s cap needs generous spacing
    const isReady = await publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationReady',
      args: [operationId],
    })
    return { isDone, isPending, isReady }
  }

  const [isDone, isPending, isReady] = await Promise.all([
    publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationDone',
      args: [operationId],
    }),
    publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationPending',
      args: [operationId],
    }),
    publicClient.readContract({
      address: timelockAddress,
      abi: TIMELOCK_ABI,
      functionName: 'isOperationReady',
      args: [operationId],
    }),
  ])

  return { isDone, isPending, isReady }
}

/**
 * Fetches queued timelock ops for a network from the auto-execution queue.
 *
 * Reads from the non-sensitive `MONGODB_URI` cluster. Ops
 * are written here by `confirm-safe-tx.ts` after the originating Safe tx
 * mines on-chain.
 *
 * @param networkName - Lowercase network name to filter by.
 * @returns Queued rows for the network. Re-verified on-chain before execution.
 */
async function fetchQueuedTimelockOps(
  networkName: string
): Promise<ITimelockQueueDoc[]> {
  const { client, timelockQueue } = await getTimelockQueueCollection()
  try {
    const rows = await timelockQueue
      .find({
        network: networkName.toLowerCase(),
        status: 'queued',
      })
      .toArray()
    return rows
  } finally {
    await client.close()
  }
}

/** Outcome of the fleet pre-check, as the run needs it. */
interface IPrefetchedWork {
  /** Networks worth opening an RPC for: queued ops to execute, blocked ops to re-check, or both. */
  networks: INetworksObject[string][]
  /**
   * Networks the prefetch could not check. Non-zero must fail the run even when
   * other networks had work: those networks were not looked at either way.
   */
  failedCount: number
}

/**
 * Fetches `blocked` timelock ops for a network — rows the pre-execute guard
 * refused for a durable reason. Never executed by this runner; read only so
 * {@link alertBlockedOps} can keep them visible for as long as they stay
 * executable on-chain.
 *
 * @param networkName - Lowercase network name to filter by.
 * @returns Blocked rows for the network.
 */
async function fetchBlockedTimelockOps(
  networkName: string
): Promise<ITimelockQueueDoc[]> {
  const { client, timelockQueue } = await getTimelockQueueCollection()
  try {
    return await timelockQueue
      .find({
        network: { $eq: networkName.toLowerCase() },
        status: { $eq: 'blocked' },
      })
      .toArray()
  } finally {
    await client.close()
  }
}

/**
 * Applies a reconciliation write only while the row is still `blocked`.
 *
 * `alertBlockedOps` reads its rows up front, then does per-row RPC work before
 * writing, so an operator running `requeue-timelock-op.ts` in that window could
 * otherwise have their `queued` row overwritten by a decision made against the
 * older state. Guarding on `status` makes each write a compare-and-swap; a
 * no-match means the operator won, which is the correct outcome and only worth a
 * debug line.
 *
 * @param timelockQueue - The queue collection.
 * @param networkName - Network slug of the row.
 * @param operationId - Operation id of the row.
 * @param update - The Mongo update to apply if the row is still blocked.
 */
async function reconcileBlockedRow(
  timelockQueue: Collection<ITimelockQueueDoc>,
  networkName: string,
  operationId: Hex,
  update: UpdateFilter<ITimelockQueueDoc>
): Promise<void> {
  const result = await timelockQueue.updateOne(
    { ...byOperationId(networkName, operationId), status: { $eq: 'blocked' } },
    update
  )
  if (result.matchedCount === 0)
    consola.debug(
      `[${networkName}] Skipped reconciling ${operationId}: no longer blocked (concurrently requeued or reconciled).`
    )
}

/**
 * Re-checks every `blocked` row for this network against the chain and keeps it
 * from going quiet.
 *
 * Three outcomes matter. A blocked op that turns out to be `isOperationDone`
 * (executed by hand, or by another path) is reconciled to `executed`, and one the
 * controller no longer knows about is reconciled to `cancelled` — both stop being
 * reported. A blocked op that is still `isOperationReady` is a live, executable
 * operation the runner is deliberately ignoring: it gets a Slack alert, throttled
 * by `blockedAlertedAt` so a standing block re-raises every few hours instead of
 * once (EXSC-816) or every ten minutes.
 *
 * Never executes anything and never fails the run: a standing block is an
 * already-reported operator task, not a malfunction of this run.
 */
async function alertBlockedOps(
  publicClient: PublicClient,
  timelockAddress: Address,
  networkName: string,
  isDryRun: boolean,
  slackNotifier?: SlackNotifier
): Promise<void> {
  let blockedRows: ITimelockQueueDoc[]
  try {
    blockedRows = await fetchBlockedTimelockOps(networkName)
  } catch (error) {
    consola.warn(
      `[${networkName}] Could not read blocked timelock ops: ${error}`
    )
    return
  }
  if (blockedRows.length === 0) return

  const candidates: IBlockedOpCandidate[] = []
  const doneRows: ITimelockQueueDoc[] = []
  const goneRows: ITimelockQueueDoc[] = []
  for (const row of blockedRows)
    try {
      // Readiness is read from the canonical controller, never the address the
      // row carries. Surface a divergence rather than letting it silence the
      // alert — going quiet is the failure mode this pass exists to prevent.
      if (row.timelockAddress.toLowerCase() !== timelockAddress.toLowerCase())
        consola.warn(
          `[${networkName}] Blocked op ${row.operationId} records timelock ${row.timelockAddress}, ` +
            `but the deployment's controller is ${timelockAddress}; reading readiness from the canonical one.`
        )
      const { isDone, isPending, isReady } = await checkOperationStatus(
        publicClient,
        timelockAddress,
        row.operationId,
        networkName
      )
      // `isOperation` is only read when done/pending/ready cannot already settle
      // the classification, keeping the common path at three reads.
      const isOperation =
        isDone || isPending || isReady
          ? true
          : ((await publicClient.readContract({
              address: timelockAddress,
              abi: TIMELOCK_ABI,
              functionName: 'isOperation',
              args: [row.operationId],
            })) as boolean)

      switch (classifyBlockedRow({ isDone, isPending, isReady, isOperation })) {
        case 'done':
          doneRows.push(row)
          break
        case 'gone':
          goneRows.push(row)
          break
        default:
          candidates.push({ doc: row, onChainReady: isReady })
      }
    } catch (error) {
      consola.warn(
        `[${networkName}] On-chain check failed for blocked op ${row.operationId}: ${error}`
      )
      candidates.push({ doc: row, onChainReady: null })
    }

  const stillExecutable = candidates.filter(
    (c) => c.onChainReady === true
  ).length
  const now = new Date()
  const toAlert = selectBlockedNeedingAlert(candidates, now)

  if (doneRows.length > 0 || goneRows.length > 0 || toAlert.length > 0)
    try {
      const { client, timelockQueue } = await getTimelockQueueCollection()
      try {
        for (const row of goneRows) {
          consola.info(
            `[${networkName}] Blocked op ${row.operationId} no longer exists on the controller (cancelled); reconciling queue row to cancelled.`
          )
          if (!isDryRun)
            await reconcileBlockedRow(
              timelockQueue,
              networkName,
              row.operationId,
              {
                $set: {
                  status: 'cancelled',
                  cancelledAt: now,
                  updatedAt: now,
                },
                $unset: staleStatusMetadataUnset('cancelled'),
              }
            )
        }
        for (const row of doneRows) {
          consola.info(
            `[${networkName}] Blocked op ${row.operationId} is done on-chain; reconciling queue row to executed.`
          )
          if (!isDryRun)
            await reconcileBlockedRow(
              timelockQueue,
              networkName,
              row.operationId,
              {
                $set: { status: 'executed', executedAt: now, updatedAt: now },
                $unset: staleStatusMetadataUnset('executed'),
              }
            )
        }
        for (const row of toAlert) {
          consola.error(
            `[${networkName}] 🚨 Blocked timelock op ${row.operationId} is READY on-chain and will not be auto-executed. ` +
              `Reason: ${row.blockedReason ?? 'unknown'}`
          )
          if (isDryRun) continue
          if (slackNotifier)
            try {
              await slackNotifier.notifyBlockedOperation({
                network: networkName,
                operationId: row.operationId,
                safeTxHash: row.safeTxHash,
                reason: row.blockedReason ?? 'unknown',
                blockedAt: row.blockedAt,
              })
            } catch (error) {
              consola.warn(
                `[${networkName}] Failed to send blocked-op notification:`,
                error
              )
            }
          // Stamped regardless of Slack success: the console/CI log already
          // carries the alert, and a webhook outage must not turn the throttle
          // into a per-run alert storm once Slack recovers.
          await reconcileBlockedRow(
            timelockQueue,
            networkName,
            row.operationId,
            {
              $set: { blockedAlertedAt: now, updatedAt: now },
            }
          )
        }
      } finally {
        await client.close()
      }
    } catch (error) {
      consola.warn(
        `[${networkName}] Could not update blocked timelock rows: ${error}`
      )
    }

  if (stillExecutable > 0)
    consola.warn(
      `[${networkName}] ⚠️ ${stillExecutable} blocked timelock op(s) still executable on-chain — ` +
        `inspect with: bunx tsx ./script/deploy/safe/list-timelock-queue.ts --network ${networkName} --attention`
    )
}

/**
 * Pre-checks the fleet, reports the outcome, and returns the networks worth
 * opening an RPC for.
 *
 * A network whose only rows are `blocked` is returned too: it has nothing to
 * execute, but {@link alertBlockedOps} must still re-check those rows on-chain.
 *
 * Exits non-zero immediately when there is no work but some networks could not
 * be checked: "0 pending" is only trustworthy if every network was actually
 * reached. When there *is* work, the run proceeds so the reachable networks are
 * executed, and the caller fails the run afterwards via `failedCount`.
 *
 * @param networksToProcess - Networks to pre-check.
 * @returns The networks to process and how many could not be checked.
 */
async function prefetchNetworksWithPendingOps(
  networksToProcess: INetworksObject[string][]
): Promise<IPrefetchedWork> {
  const {
    withPending,
    withBlocked,
    toProcess,
    skipped,
    failed,
    mustExitWithError,
  } = classifyPrefetchResults(await fetchPendingForNetworks(networksToProcess))

  consola.info(
    `Checked ${networksToProcess.length - skipped.length - failed.length} of ${
      networksToProcess.length
    } network(s) (MongoDB only); ${
      withPending.length
    } have pending timelock tx(s)${
      withPending.length > 0
        ? `: ${withPending.map((r) => r.network.name).join(', ')}`
        : ''
    }`
  )
  if (withBlocked.length > 0)
    consola.warn(
      `${
        withBlocked.length
      } network(s) have blocked timelock op(s) awaiting operator action: ${withBlocked
        .map((r) => `${r.network.name} (${r.blockedInMongoCount})`)
        .join(', ')}`
    )
  if (skipped.length > 0)
    consola.info(
      `Skipped ${
        skipped.length
      } network(s) without a production timelock: ${skipped
        .map((r) => `${r.network.name} (${r.skipReason})`)
        .join(', ')}`
    )
  if (failed.length > 0)
    consola.warn(
      `Prefetch failed for ${failed.length} network(s): ${failed
        .map((r) => r.network.name)
        .join(', ')}`
    )

  if (mustExitWithError) {
    consola.error(
      'No networks with pending timelock txs; some networks failed to fetch. Exiting with error to avoid silently skipping work.'
    )
    process.exit(1)
  }
  if (toProcess.length === 0)
    consola.success('No networks with pending timelock transactions.')

  return {
    networks: toProcess.map((r) => r.network),
    failedCount: failed.length,
  }
}

async function processNetwork(
  network: INetworksObject[string],
  isDryRun: boolean,
  specificOperationId?: Hex,
  executeAll?: boolean,
  rejectAll?: boolean,
  rpcUrlOverride?: string,
  slackNotifier?: SlackNotifier
): Promise<INetworkResult> {
  // Only show network header in sequential mode (when not using auto-execute flags)
  const isSequentialMode = !executeAll && !rejectAll
  if (isSequentialMode)
    consola.info(
      `\n[${network.name}] 📡 ${network.name} (Chain ID: ${network.chainId})`
    )

  try {
    // Always load deployment and open a fresh RPC so the connection is never stale (e.g. after long interactive pause or 60+ parallel prefetches).
    const deploymentData = (await getDeployments(
      network.name as SupportedChain,
      EnvironmentEnum.production
    )) as { LiFiTimelockController?: string }

    if (!deploymentData.LiFiTimelockController) {
      consola.warn(
        `[${network.name}] ⚠️  No timelock controller deployed on ${network.name}`
      )

      return {
        network: network.name,
        success: true,
        operationsProcessed: 0,
      }
    }

    const timelockAddress = normalizeAddressForNetwork(
      network.name,
      deploymentData.LiFiTimelockController
    )

    const { publicClient, walletClient } = await setupEnvironment(
      network.name as SupportedChain,
      null,
      EnvironmentEnum.production,
      rpcUrlOverride
    )

    const chainCaller = await createChainCaller({
      networkName: network.name,
      walletClient,
      publicClient,
      privateKeyHex: process.env.PRIVATE_KEY_PRODUCTION,
    })

    // Runs before the ready-operations check so a network whose only rows are
    // blocked still gets its on-chain re-check and alert.
    await alertBlockedOps(
      publicClient,
      timelockAddress,
      network.name,
      isDryRun,
      slackNotifier
    )

    const {
      readyOperations,
      totalPendingCount,
      notScheduledOperations,
      processingErrors,
    } = await getPendingOperations(
      publicClient,
      timelockAddress,
      network.name,
      specificOperationId,
      rejectAll,
      slackNotifier
    )

    if (readyOperations.length === 0) {
      if (totalPendingCount === 0)
        consola.info(`[${network.name}] ✅ No pending operations found`)
      else
        consola.info(
          `[${network.name}] ✅ No operations ready for execution (${totalPendingCount} pending but not ready)`
        )

      // Consider it a failure if there were not-scheduled rows (manual fix
      // required) or row-processing errors (RPC errors etc., transient but
      // still need surfacing).
      const failureCount = notScheduledOperations.length + processingErrors

      return {
        network: network.name,
        success: failureCount === 0,
        operationsProcessed: 0,
        operationsFailed: failureCount,
      }
    }

    consola.info(
      `[${network.name}] 📋 Found ${readyOperations.length} pending operation${
        readyOperations.length === 1 ? '' : 's'
      }`
    )

    // Execute or reject each ready operation
    let operationsProcessed = 0
    let operationsSucceeded = 0
    let operationsFailed = 0
    let operationsRejected = 0
    let operationsSkipped = 0
    const totalGasUsed = 0n

    for (const operation of readyOperations) {
      if (rejectAll) {
        const rejectResult = await rejectOperation(
          chainCaller,
          timelockAddress,
          operation,
          isDryRun,
          network.name
        )
        operationsProcessed++
        if (rejectResult === 'rejected') operationsRejected++
        else if (rejectResult === 'failed') operationsFailed++
      } else {
        // Determine if we should use interactive mode
        const isInteractive = !executeAll && !rejectAll

        const result = await executeOperation(
          chainCaller,
          publicClient,
          timelockAddress,
          operation,
          isDryRun,
          isInteractive,
          network.name,
          slackNotifier,
          network.chainId,
          network.name
        )

        // Log the result for interactive mode
        if (isInteractive)
          consola.info(`[${network.name}] Operation ${operation.id}: ${result}`)

        // Track statistics
        operationsProcessed++
        if (result === 'executed') operationsSucceeded++
        else if (result === 'failed') operationsFailed++
        else if (result === 'rejected') operationsRejected++
        else if (result === 'skipped') operationsSkipped++
      }
      // TronGrid caps the API key at 15 req/s; each op fires ~3-5 RPC calls
      // (simulate + broadcast + receipt poll), so pace iterations on Tron.
      if (isTronNetworkKey(network.name)) await sleep(2000) // 2 s
    }

    // Only send network completion notification if there were actual operations executed or failures
    if (slackNotifier && (operationsSucceeded > 0 || operationsFailed > 0))
      try {
        const stats: IProcessingStats = {
          operationsProcessed,
          operationsSucceeded,
          operationsFailed,
          totalGasUsed,
        }
        await slackNotifier.notifyNetworkProcessingComplete(network.name, stats)
      } catch (error) {
        consola.warn('Failed to send network completion notification:', error)
      }

    // Track not-scheduled operations and per-row processing errors as failures.
    const notScheduledCount = notScheduledOperations.length
    if (notScheduledCount > 0) operationsFailed += notScheduledCount
    if (processingErrors > 0) operationsFailed += processingErrors

    // Determine overall success - only true if no operations failed
    const success = operationsFailed === 0

    // Log summary for this network if there were operations or not-scheduled issues
    if (operationsProcessed > 0 || notScheduledCount > 0) {
      consola.info(
        `[${network.name}] Summary: ${operationsSucceeded} executed, ${operationsRejected} rejected, ${operationsFailed} failed (including ${notScheduledCount} not scheduled), ${operationsSkipped} skipped`
      )
      if (!success)
        consola.error(
          `[${network.name}] ❌ Network processing completed with ${operationsFailed} failure(s)`
        )
    }

    return {
      network: network.name,
      success,
      operationsProcessed,
      operationsFailed,
      operationsSucceeded,
      operationsRejected,
      operationsSkipped,
    }
  } catch (error) {
    consola.error(
      `[${network.name}] Error processing network ${network.name}:`,
      error
    )

    return {
      network: network.name,
      success: false,
      operationsProcessed: 0,
      operationsFailed: 0,
      operationsSucceeded: 0,
      operationsRejected: 0,
      operationsSkipped: 0,
      error,
    }
  }
}

async function getPendingOperations(
  publicClient: PublicClient,
  timelockAddress: Address,
  networkName: string,
  specificOperationId?: Hex,
  isCancellingOperations?: boolean,
  slackNotifier?: SlackNotifier,
  options?: { quiet?: boolean }
): Promise<{
  readyOperations: ITimelockOperation[]
  totalPendingCount: number
  notScheduledOperations: Array<{
    operationId: string
    transactionId: string
    safeTxHash: string
    executionHash?: string
  }>
  processingErrors: number
}> {
  const quiet = options?.quiet === true
  const log = (msg: string, ...rest: unknown[]) => {
    if (!quiet) consola.info(msg, ...rest)
  }

  log(
    `[${networkName}] 🔒 Timelock: ${timelockAddress} - Fetching queued ops...`
  )
  const queueRows = await fetchQueuedTimelockOps(networkName)

  if (queueRows.length === 0) {
    log(`[${networkName}] No queued timelock ops`)
    return {
      readyOperations: [],
      totalPendingCount: 0,
      notScheduledOperations: [],
      processingErrors: 0,
    }
  }

  log(`[${networkName}] Found ${queueRows.length} queued timelock op(s)`)

  let processingErrors = 0
  const readyOperations: ITimelockOperation[] = []
  const notScheduledOperations: Array<{
    operationId: string
    transactionId: string
    safeTxHash: string
    executionHash?: string
  }> = []
  const { client, timelockQueue } = await getTimelockQueueCollection()

  try {
    for (const row of queueRows)
      try {
        const params = deserializeScheduleParams(row)
        const { targets, values, payloads, predecessor, salt, delay } = params

        if (
          targets.length === 0 ||
          values.length === 0 ||
          payloads.length === 0
        ) {
          consola.warn(
            `[${networkName}] Queue row ${row.operationId} has empty arrays; marking failed.`
          )
          await markTimelockOpFailedInQueue(
            timelockQueue,
            row.network,
            row.operationId,
            'empty schedule arrays'
          )
          continue
        }
        if (
          targets.length !== values.length ||
          values.length !== payloads.length
        ) {
          consola.warn(
            `[${networkName}] Queue row ${row.operationId} has inconsistent array lengths; marking failed.`
          )
          await markTimelockOpFailedInQueue(
            timelockQueue,
            row.network,
            row.operationId,
            'inconsistent schedule array lengths'
          )
          continue
        }

        // Trust check 1: re-derive operationId from queue params and assert
        // it matches the stored operationId. A mismatch means the row was
        // tampered with — refuse to act on it.
        const opId = computeOperationIdBatch(
          targets,
          values,
          payloads,
          predecessor,
          salt
        )
        if (opId !== row.operationId) {
          consola.error(
            `[${networkName}] ❌ operationId mismatch on queue row (stored=${row.operationId}, derived=${opId}); marking failed.`
          )
          await markTimelockOpFailedInQueue(
            timelockQueue,
            row.network,
            row.operationId,
            'operationId mismatch — possible tampered row'
          )
          continue
        }

        // Trust check 2: cross-check the queue row's timelockAddress against
        // the canonical address from the deployment log. Mismatch → skip.
        if (
          row.timelockAddress.toLowerCase() !== timelockAddress.toLowerCase()
        ) {
          consola.error(
            `[${networkName}] ❌ timelockAddress mismatch on queue row (stored=${row.timelockAddress}, canonical=${timelockAddress}); marking failed.`
          )
          await markTimelockOpFailedInQueue(
            timelockQueue,
            row.network,
            row.operationId,
            'timelockAddress mismatch with deployment'
          )
          continue
        }

        // If a specific operation ID is provided, check only that one
        if (specificOperationId && opId !== specificOperationId) continue

        // Check operation status in the timelock controller
        const status = await checkOperationStatus(
          publicClient,
          timelockAddress,
          opId,
          networkName
        )

        if (status.isDone) {
          log(
            `[${networkName}] Operation ${opId} is already executed. Marking queue row as executed.`
          )
          const now = new Date()
          await timelockQueue.updateOne(byOperationId(networkName, opId), {
            $set: { status: 'executed', executedAt: now, updatedAt: now },
          })

          // Close the alert loop: a row left 'queued' by an unconfirmed run
          // already emitted a failure notification, so the retroactive
          // discovery of its success must be announced too (EXSC-503).
          const primaryTarget = targets[0]
          const primaryValue = values[0]
          const primaryPayload = payloads[0]
          if (
            slackNotifier &&
            primaryTarget &&
            primaryValue !== undefined &&
            primaryPayload
          )
            try {
              await slackNotifier.notifyOperationExecuted({
                network: networkName,
                operation: {
                  id: opId,
                  target: primaryTarget,
                  value: primaryValue,
                  data: primaryPayload,
                  functionName: `batch (${targets.length} calls) — found already executed on-chain`,
                },
                status: 'success',
                transactionHash: row.executionTxHash,
              })
            } catch (error) {
              consola.warn(
                'Failed to send reconciled-execution notification:',
                error
              )
            }
          continue
        }

        // Check if operation exists on-chain when not ready
        if (!status.isPending && !status.isReady) {
          const isOperation = await publicClient.readContract({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: 'isOperation',
            args: [opId],
          })

          if (!isOperation) {
            consola.error(
              `[${networkName}] ❌ Operation ${opId} does not exist on-chain! The timelock transaction was never scheduled.`
            )
            consola.error(`[${networkName}]    Safe Tx Hash: ${row.safeTxHash}`)
            if (row.executionHash)
              consola.error(
                `[${networkName}]    Execution Hash: ${row.executionHash}`
              )

            consola.error(
              `[${networkName}]    This Safe transaction needs to be re-executed to schedule it in the timelock.`
            )
            notScheduledOperations.push({
              operationId: opId,
              transactionId: row._id ? row._id.toString() : opId,
              safeTxHash: row.safeTxHash,
              executionHash: row.executionHash,
            })
            continue
          }
        }

        const baseOp: Omit<ITimelockOperation, 'functionName'> = {
          id: opId,
          index: 0n,
          predecessor,
          delay,
          salt,
          safeTxHash: row.safeTxHash,
          targets,
          values,
          payloads,
        }

        if (status.isReady) {
          const callCount = targets.length
          log(
            `[${networkName}] ✅ Operation ${opId} is ready for execution (batch of ${callCount} calls)`
          )

          readyOperations.push({
            ...baseOp,
            functionName: `batch (${callCount} calls)`,
          })
        } else if (isCancellingOperations && status.isPending) {
          const timestamp = await publicClient.readContract({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: 'getTimestamp',
            args: [opId],
          })

          const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
          const remainingTime = timestamp - currentTimestamp

          log(
            `[${networkName}] ⏰ Operation ${opId} is pending (${formatTimeRemaining(
              remainingTime
            )} remaining) - will be cancelled`
          )

          readyOperations.push({
            ...baseOp,
            functionName: `batch (${targets.length} calls)`,
          })
        } else if (status.isPending) {
          const timestamp = await publicClient.readContract({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: 'getTimestamp',
            args: [opId],
          })

          const currentTimestamp = BigInt(Math.floor(Date.now() / 1000))
          const remainingTime = timestamp - currentTimestamp

          log(
            `[${networkName}] ⏰ Operation ${opId} not ready yet (${formatTimeRemaining(
              remainingTime
            )} remaining)`
          )
        }
      } catch (error) {
        processingErrors++
        const errorMessage =
          error instanceof Error ? error.message : String(error)
        consola.error(
          `[${networkName}] Error processing queue row ${row.operationId}: ${errorMessage}`
        )
      }
  } finally {
    await client.close()
  }

  const operationAction = isCancellingOperations
    ? 'to cancel'
    : 'ready to execute'
  log(
    `[${networkName}] 🚀 Found ${readyOperations.length} operation${
      readyOperations.length === 1 ? '' : 's'
    } ${operationAction}`
  )

  // Send Slack notification for not-scheduled operations if any were found
  if (notScheduledOperations.length > 0 && slackNotifier)
    try {
      await slackNotifier.notifyNotScheduled(
        networkName,
        notScheduledOperations
      )
    } catch (error) {
      consola.warn('Failed to send not-scheduled notification:', error)
    }

  return {
    readyOperations,
    totalPendingCount: queueRows.length,
    notScheduledOperations,
    processingErrors,
  }
}

/**
 * Records a reverted `executeBatch` and, once the row has burned its retry
 * budget, blocks it and alerts the CI notifications channel.
 *
 * Reverting is the one execution failure that is usually about the payload
 * rather than the environment, so retrying it forever burns gas and buries the
 * signal under an alert every ten minutes. Past
 * {@link REVERT_BLOCK_THRESHOLD} the row becomes `blocked`, which hands it to
 * the machinery that already exists for operator-owned states: `--attention` in
 * the lister, the recurring standing-block reminder, and
 * `requeue-timelock-op.ts` once the cause is cleared.
 *
 * The escalation goes to `WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS` (same
 * convention as `reconcile-parked-tasks.ts`). An unattended run that has this
 * alert to deliver and no webhook configured throws rather than dropping it —
 * a silently undelivered alert is the failure mode this whole change exists to
 * remove.
 *
 * Best-effort on the bookkeeping: a Mongo error is logged and does not change
 * the caller's decision, which is already "this run failed".
 */
async function handleRevertedExecution(
  networkName: string,
  operation: ITimelockOperation,
  txHash: string,
  networkPrefix: string
): Promise<void> {
  let revertCount: number
  try {
    const { client, timelockQueue } = await getTimelockQueueCollection()
    try {
      revertCount = await recordTimelockOpRevert(
        timelockQueue,
        networkName,
        operation.id,
        txHash
      )
    } finally {
      await client.close()
    }
  } catch (error) {
    consola.warn(
      `${networkPrefix} Could not record the reverted attempt for ${operation.id}: ${error}`
    )
    return
  }

  if (!shouldBlockAfterRevert(revertCount)) {
    consola.warn(
      `${networkPrefix} Operation ${operation.id} has reverted ${revertCount}/${REVERT_BLOCK_THRESHOLD} time(s); ` +
        'leaving it queued in case the cause is transient.'
    )
    return
  }

  await blockTimelockOp(
    networkName,
    operation.id,
    `executeBatch reverted on-chain ${revertCount} time(s); last tx ${txHash}`,
    networkPrefix
  )

  const webhookUrl = process.env.WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS
  if (!webhookUrl) {
    const message =
      `${networkPrefix} Operation ${operation.id} was blocked after ${revertCount} on-chain reverts, ` +
      'but WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS is unset so the alert cannot be delivered. ' +
      'Set the SLACK_WEBHOOK_DEV_SC_GITHUB_CI_NOTIFICATIONS repository secret.'
    if (isUnattendedRun()) throw new Error(message)
    consola.warn(`${message} (local run: logged only)`)
    return
  }

  try {
    await new SlackNotifier(
      webhookUrl,
      process.env.TIMELOCK_RUN_URL
    ).notifyRepeatedRevert({
      network: networkName,
      operationId: operation.id,
      safeTxHash: operation.safeTxHash ?? 'unknown',
      revertCount,
      lastRevertTxHash: txHash,
    })
    consola.info(
      `${networkPrefix} Alerted the CI notifications channel about ${operation.id}`
    )
  } catch (error) {
    consola.error(
      `${networkPrefix} Failed to alert the CI notifications channel about ${operation.id}:`,
      error
    )
  }
}

/**
 * Marks a timelock queue row `blocked` so the cron stops retrying a batch that
 * failed pre-execute re-validation, without burying it: blocked rows stay
 * visible in `list-timelock-queue`, are re-alerted by {@link alertBlockedOps}
 * while they remain executable on-chain, and can be re-driven with
 * `requeue-timelock-op.ts` once the cause is cleared.
 *
 * Best-effort: a Mongo error is logged and does not change the caller's abort
 * decision.
 */
async function blockTimelockOp(
  networkName: string,
  operationId: Hex,
  reason: string,
  networkPrefix: string
): Promise<void> {
  try {
    const { client, timelockQueue } = await getTimelockQueueCollection()
    try {
      await markTimelockOpBlocked(
        timelockQueue,
        networkName,
        operationId,
        reason
      )
      consola.info(
        `${networkPrefix} Marked queue row ${operationId} as blocked (${reason}). ` +
          `Re-drive with: bunx tsx ./script/deploy/safe/requeue-timelock-op.ts ` +
          `--network ${networkName} --operationId ${operationId}`
      )
    } finally {
      await client.close()
    }
  } catch (error) {
    consola.warn(
      `${networkPrefix} Failed to mark timelock queue row blocked: ${error}`
    )
  }
}

/** Loupe ABI for the pre-execute revalidation read (same shape as diamondRemovalDiff). */
const FACETS_LOUPE_ABI = parseAbi([
  'function facets() view returns ((address facetAddress, bytes4[] functionSelectors)[])',
])

/**
 * Verdict of the pre-execute removal guard. `retry` and `blocked` both refuse
 * the current run; they differ in what they persist, and conflating them is what
 * turned a recoverable abort into a dead end (EXSC-816):
 *
 * - `ok` — safe to execute.
 * - `retry` — a transient outage (parked-tasks queue or loupe RPC unreachable).
 *   The row stays `queued`, so the next cron tick tries again on its own.
 * - `blocked` — a durable condition an operator must clear. The row is flipped
 *   to `blocked`: still visible, still re-alerted, never auto-retried.
 */
type GuardOutcome = 'ok' | 'retry' | 'blocked'

/**
 * Pre-execute guard for folded parked facet removals. Rebuilds the propose-time
 * snapshot from Remove payloads + parked tasks (doomed addresses), re-reads the
 * loupe via the runner's `publicClient` (honours `--rpcUrl`), and aborts the
 * whole batch if any selector is stale. Remove cuts with no parked rows for the
 * Safe tx hash also abort — doomed addresses are not recoverable from calldata
 * (`facetAddress = 0`), so executing blind would reopen the silent-delete hole
 * (covers unlink after a best-effort drain link failure, and legacy
 * `cleanUpProdDiamond` until those removals park too).
 *
 * @returns See {@link GuardOutcome}.
 */
async function revalidateFoldedRemovalsOrAbort(
  operation: ITimelockOperation,
  networkName: string,
  networkPrefix: string,
  isDryRun: boolean,
  notifyFailure: (error: unknown) => Promise<void>,
  publicClient: PublicClient
): Promise<GuardOutcome> {
  if (!operation.safeTxHash) return 'ok'

  const alertFailure = async (error: unknown): Promise<void> => {
    if (!isDryRun) await notifyFailure(error)
  }

  let parked: Awaited<ReturnType<typeof listParkedTasksBySafeTxHash>>
  try {
    const { client, parkedTasks } = await getParkedTasksCollection()
    try {
      parked = await listParkedTasksBySafeTxHash(
        parkedTasks,
        operation.safeTxHash
      )
    } finally {
      await client.close()
    }
  } catch (error) {
    // Queue unreachable — refuse Remove cuts rather than execute them blind.
    // Leave the row queued so a transient outage can retry (do not mark failed).
    const removeHint = buildRemovalSnapshotFromPayloads(operation.payloads, [])
    if (removeHint.kind === 'none') return 'ok'
    consola.warn(
      `${networkPrefix} ⚠️ Could not open parked-tasks queue to revalidate Remove cut(s); refusing execute (row left queued, next run retries):`,
      error
    )
    await alertFailure(
      new Error('parked-tasks queue unreachable for Remove revalidation')
    )
    return 'retry'
  }

  const built = buildRemovalSnapshotFromPayloads(
    operation.payloads,
    parked.map((t) => ({
      facetName: t.facetName,
      facetAddress: t.facetAddress,
    }))
  )

  if (built.kind === 'none') return 'ok'

  if (built.kind === 'unvalidated') {
    // Fail closed: without parked doomed addresses we cannot revalidate, and
    // warn-then-proceed would reopen silent live-selector deletion on unlink /
    // legacy cleanup. Cancel the op and re-propose via the parked drain (or
    // park the facets first for cleanUpProdDiamond).
    const reason = `Remove diamondCut(s) present (${built.removeCutCount}) but no parked tasks for safeTxHash ${operation.safeTxHash} — cannot revalidate; aborting whole batch`
    consola.error(`${networkPrefix} ❌ ${reason}`)
    if (!isDryRun)
      await blockTimelockOp(
        networkName,
        operation.id,
        'Remove cuts without parked-task snapshot — cannot revalidate',
        networkPrefix
      )
    await alertFailure(new Error(reason))
    return 'blocked'
  }

  if (built.kind === 'mismatch') {
    consola.error(
      `${networkPrefix} ❌ Folded-removal snapshot mismatch — aborting whole batch: ${built.reason}`
    )
    if (!isDryRun)
      await blockTimelockOp(
        networkName,
        operation.id,
        `folded-removal snapshot mismatch: ${built.reason}`,
        networkPrefix
      )
    await alertFailure(
      new Error(`folded-removal snapshot mismatch: ${built.reason}`)
    )
    return 'blocked'
  }

  const diamondAddress = parked[0]?.diamondAddress
  if (!diamondAddress) {
    consola.error(
      `${networkPrefix} ❌ Parked tasks missing diamondAddress — aborting whole batch`
    )
    if (!isDryRun)
      await blockTimelockOp(
        networkName,
        operation.id,
        'parked tasks missing diamondAddress',
        networkPrefix
      )
    await alertFailure(new Error('parked tasks missing diamondAddress'))
    return 'blocked'
  }

  let revalidated: Awaited<ReturnType<typeof revalidateRemovalsOnChain>>
  try {
    revalidated = await revalidateRemovalsOnChain(
      networkName,
      diamondAddress,
      built.snapshot,
      {
        getOnChainFacets: async (diamond) => {
          const raw = await publicClient.readContract({
            address: diamond,
            abi: FACETS_LOUPE_ABI,
            functionName: 'facets',
          })
          return mapLoupeResult(raw)
        },
      }
    )
  } catch (error) {
    // Loupe/RPC blip — refuse this run but leave queued for retry.
    consola.error(
      `${networkPrefix} ❌ Pre-execute removal revalidation failed — refusing execute (row left queued, next run retries):`,
      error
    )
    await alertFailure(error)
    return 'retry'
  }

  if (revalidated.stale.length === 0) {
    consola.info(
      `${networkPrefix} ✅ Pre-execute removal revalidation OK (${built.snapshot.length} folded facet(s))`
    )
    return 'ok'
  }

  const { fullyObsolete, detail, remediation } =
    describeStaleRemovals(revalidated)
  const headline = fullyObsolete
    ? 'Stale folded removals, ALL obsolete — aborting whole batch (primary cut included)'
    : 'Stale folded removals — aborting whole batch (primary cut included)'
  consola.error(
    `${networkPrefix} ❌ ${headline}. ${remediation} Stale: ${detail}`
  )
  const reason = `${
    fullyObsolete ? 'obsolete' : 'stale'
  } folded removals: ${detail}`
  if (!isDryRun)
    await blockTimelockOp(networkName, operation.id, reason, networkPrefix)
  await alertFailure(new Error(`${reason}. ${remediation}`))
  return 'blocked'
}

async function executeOperation(
  chainCaller: IChainCaller,
  publicClient: PublicClient,
  timelockAddress: Address,
  operation: ITimelockOperation,
  isDryRun: boolean,
  interactive?: boolean,
  networkName?: string,
  slackNotifier?: SlackNotifier,
  chainId?: number,
  network?: string
): Promise<'executed' | 'rejected' | 'skipped' | 'failed'> {
  const networkPrefix = networkName ? `[${networkName}]` : ''
  const callCount = operation.targets.length
  const primaryTarget = operation.targets[0]
  const primaryValue = operation.values[0]
  const primaryPayload = operation.payloads[0]
  if (!primaryTarget || primaryValue === undefined || !primaryPayload)
    throw new Error('Invalid operation: missing target/value/payload')

  const notifyFailure = async (error: unknown): Promise<void> => {
    if (!slackNotifier || !networkName) return
    try {
      await slackNotifier.notifyOperationFailed({
        network: networkName,
        operation: {
          id: operation.id,
          target: primaryTarget,
          value: primaryValue,
          data: primaryPayload,
          functionName: operation.functionName,
        },
        status: 'failed',
        error,
      })
    } catch (notifyError) {
      consola.warn(
        'Failed to send operation failure notification:',
        notifyError
      )
    }
  }

  consola.info(
    `\n${networkPrefix} ⚡ Processing operation: ${operation.id} (batch of ${callCount} calls)`
  )
  consola.info(`${networkPrefix}    Batch details:`)
  const decodeContext =
    chainId !== undefined && network ? { chainId, network } : undefined
  await formatTimelockScheduleBatch(
    [
      operation.targets,
      operation.values,
      operation.payloads,
      operation.predecessor,
      operation.salt,
      operation.delay,
    ],
    network ?? networkName ?? '',
    decodeContext
  )

  // If interactive mode, show choice prompt
  if (interactive) {
    const action = await consola.prompt('Select action:', {
      type: 'select',
      options: ['Execute', 'Reject', 'Skip'],
    })

    if (action === 'Skip') {
      consola.info('⏭️  Operation skipped')
      return 'skipped'
    }

    if (action === 'Reject') {
      if (!networkName) throw new Error('rejectOperation requires networkName')
      // Call rejectOperation and return
      await rejectOperation(
        chainCaller,
        timelockAddress,
        operation,
        isDryRun,
        networkName
      )
      return 'rejected'
    }

    // If action === 'Execute', continue with execution below
  }

  // Pre-execute re-validation for folded parked removals. Under the fold a
  // stale Remove would either silently delete a live selector (re-pointed) or
  // revert the whole batch (already-gone) — refuse either way.
  if (networkName) {
    const guard = await revalidateFoldedRemovalsOrAbort(
      operation,
      networkName,
      networkPrefix,
      isDryRun,
      notifyFailure,
      publicClient
    )
    if (guard !== 'ok') return 'failed'
  }

  try {
    if (operation.functionName)
      consola.info(`${networkPrefix}    Function: ${operation.functionName}`)

    // Use the salt from the operation if available, otherwise use default
    const salt =
      operation.salt ||
      ('0x0000000000000000000000000000000000000000000000000000000000000000' as Hex) // [pre-commit-checker: not a secret]

    if (isDryRun) {
      // Simulate the transaction
      consola.info(`${networkPrefix} 🔍 [DRY RUN] Simulating execution...`)

      const callData = encodeFunctionData({
        abi: TIMELOCK_ABI,
        functionName: 'executeBatch',
        args: [
          operation.targets,
          operation.values,
          operation.payloads,
          operation.predecessor,
          salt,
        ],
      })

      const { estimatedResource, resourceLabel } = await chainCaller.simulate({
        to: timelockAddress,
        data: callData,
      })

      consola.info(
        `${networkPrefix}    Estimated ${resourceLabel}: ${estimatedResource}`
      )
      consola.success(
        `${networkPrefix} ✅ [DRY RUN] Transaction simulation successful`
      )
    } else {
      // Send the actual transaction
      consola.info(`${networkPrefix} 📤 Submitting transaction...`)

      const callData = encodeFunctionData({
        abi: TIMELOCK_ABI,
        functionName: 'executeBatch',
        args: [
          operation.targets,
          operation.values,
          operation.payloads,
          operation.predecessor,
          salt,
        ],
      })

      const result = await chainCaller.call({
        to: timelockAddress,
        data: callData,
      })

      const txExplorerSuffix = result.explorerUrl
        ? ` (${result.explorerUrl})`
        : ''
      consola.info(
        `${networkPrefix}    Transaction hash: ${result.hash}${txExplorerSuffix}`
      )

      // A missing receipt (confirmation timeout, or chains without synchronous
      // receipts like Tron) must not count as success — only flip the queue row
      // once isOperationDone confirms the op on-chain (EXSC-503).
      const confirmation = await confirmTimelockExecution({
        receipt: result.receipt,
        isOperationDone: () =>
          publicClient.readContract({
            address: timelockAddress,
            abi: TIMELOCK_ABI,
            functionName: 'isOperationDone',
            args: [operation.id],
          }),
      })

      if (confirmation === 'reverted') {
        consola.error(
          `${networkPrefix} ❌ Transaction failed for operation ${operation.id}`
        )
        await notifyFailure(
          new Error(`executeBatch tx ${result.hash} reverted on-chain`)
        )
        if (!isDryRun && networkName)
          await handleRevertedExecution(
            networkName,
            operation,
            result.hash,
            networkPrefix
          )
        return 'failed'
      }

      if (confirmation === 'unconfirmed') {
        consola.warn(
          `${networkPrefix} ⚠️ Execution of operation ${operation.id} not confirmed on-chain (tx ${result.hash}); leaving queue row 'queued' for retry`
        )
        await notifyFailure(
          new Error(
            `executeBatch tx ${result.hash} not confirmed on-chain; operation left queued for retry`
          )
        )
        return 'failed'
      }

      const { hash } = result
      const gasUsed = result.gasUsed

      if (slackNotifier && networkName)
        try {
          await slackNotifier.notifyOperationExecuted({
            network: networkName,
            operation: {
              id: operation.id,
              target: primaryTarget,
              value: primaryValue,
              data: primaryPayload,
              functionName: operation.functionName,
            },
            status: 'success',
            transactionHash: hash,
            gasUsed,
          })
        } catch (error) {
          consola.warn('Failed to send operation success notification:', error)
        }

      consola.success(
        `${networkPrefix} ✅ Operation ${operation.id} executed successfully`
      )

      // Mark the queue row as executed for traceability and to skip on next run.
      if (!networkName)
        throw new Error('networkName is required to mark queue row as executed')
      try {
        const { client, timelockQueue } = await getTimelockQueueCollection()
        try {
          const now = new Date()
          await timelockQueue.updateOne(
            byOperationId(networkName, operation.id),
            {
              $set: {
                status: 'executed',
                executedAt: now,
                executionTxHash: hash,
                updatedAt: now,
              },
              $unset: staleStatusMetadataUnset('executed'),
            }
          )
          consola.info(
            `${networkPrefix} Marked queue row ${operation.id} as executed`
          )
        } finally {
          await client.close()
        }
      } catch (error) {
        consola.warn(
          `${networkPrefix} Failed to update timelock queue row: ${error}`
        )
      }
    }

    return 'executed'
  } catch (error) {
    consola.error(
      `${networkPrefix} Failed to execute operation ${operation.id}:`,
      error
    )

    if (!isDryRun) await notifyFailure(error)

    return 'failed'
  }
}

async function rejectOperation(
  chainCaller: IChainCaller,
  timelockAddress: Address,
  operation: ITimelockOperation,
  isDryRun: boolean,
  networkName: string
): Promise<'rejected' | 'failed'> {
  consola.info(`\n❌ Rejecting operation: ${operation.id}`)
  const callCount = operation.targets.length
  const primaryTarget = operation.targets[0]
  const primaryValue = operation.values[0]
  const primaryPayload = operation.payloads[0]
  if (!primaryTarget || primaryValue === undefined || !primaryPayload)
    throw new Error('Invalid operation: missing target/value/payload')
  consola.info(`   Calls: ${callCount} (batch)`)
  consola.info(`   Target: ${primaryTarget}`)
  consola.info(`   Value: ${formatEther(primaryValue)} ETH`)
  consola.info(`   Data: ${primaryPayload}`)

  try {
    consola.info(`   Function: batch (${callCount} calls)`)

    if (isDryRun) {
      // Simulate the cancellation
      consola.info(`🔍 [DRY RUN] Simulating cancellation...`)

      const cancelCalldata = encodeFunctionData({
        abi: TIMELOCK_ABI,
        functionName: 'cancel',
        args: [operation.id],
      })

      const { estimatedResource, resourceLabel } = await chainCaller.simulate({
        to: timelockAddress,
        data: cancelCalldata,
      })

      consola.info(`   Estimated ${resourceLabel}: ${estimatedResource}`)
      consola.success(`✅ [DRY RUN] Cancellation simulation successful`)
      return 'rejected'
    } else {
      // Send the actual cancellation transaction
      consola.info(`📤 Submitting cancellation transaction...`)

      const cancelCalldata = encodeFunctionData({
        abi: TIMELOCK_ABI,
        functionName: 'cancel',
        args: [operation.id],
      })

      const result = await chainCaller.call({
        to: timelockAddress,
        data: cancelCalldata,
      })

      consola.info(`   Transaction hash: ${result.hash}`)

      if (result.receipt && result.receipt.status !== 'success') {
        consola.error(`❌ Cancellation failed for operation ${operation.id}`)
        return 'failed'
      }

      consola.success(`✅ Operation ${operation.id} cancelled successfully`)

      // Mark the queue row as cancelled.
      try {
        const { client, timelockQueue } = await getTimelockQueueCollection()
        try {
          const now = new Date()
          await timelockQueue.updateOne(
            byOperationId(networkName, operation.id),
            {
              $set: {
                status: 'cancelled',
                cancelledAt: now,
                executionTxHash: result.hash,
                updatedAt: now,
              },
            }
          )
          consola.info(`Marked queue row ${operation.id} as cancelled`)
        } finally {
          await client.close()
        }
      } catch (error) {
        consola.warn(`Failed to update timelock queue row: ${error}`)
      }
      return 'rejected'
    }
  } catch (error) {
    consola.error(`Failed to cancel operation ${operation.id}:`, error)
    return 'failed'
  }
}

// Helper function to format remaining time in a human-readable format
function formatTimeRemaining(seconds: bigint): string {
  if (seconds <= 0n) return 'Ready to execute'

  const days = seconds / 86400n
  const hours = (seconds % 86400n) / 3600n
  const minutes = (seconds % 3600n) / 60n
  const secs = seconds % 60n

  let result = ''
  if (days > 0n) result += `${days}d `
  if (hours > 0n) result += `${hours}h `
  if (minutes > 0n) result += `${minutes}m `
  result += `${secs}s`

  return result
}

// Deliberately unguarded. An `import.meta.main` guard would make this module
// importable, but should the flag ever read falsy for this entry the scheduled
// run exits 0 having executed nothing, indistinguishable from a clean run.
// Logic that needs test coverage goes into a sibling module instead
// (timelock-prefetch.ts).
runMain(cmd)
