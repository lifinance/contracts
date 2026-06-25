/**
 * Reconciliation of in-flight Safe transactions against on-chain state.
 *
 * Called at the top of each network's processing pass in confirm-safe-tx.
 * Two sweeps:
 *
 * - Sweep A walks every `submitted` row in MongoDB and resolves it from
 *   the receipt of its stored `executionHash`. The row is promoted to
 *   `executed`, marked `reverted`, or — when the receipt is still
 *   unavailable past a grace window — sent back to `pending` so the
 *   next proposal can reuse the nonce.
 *
 * - Sweep B is conditional: if the on-chain Safe nonce is higher than
 *   what the DB accounts for, scan recent `ExecutionSuccess` /
 *   `ExecutionFailure` logs on the Safe to back-fill rows whose
 *   execution hash never reached our DB (the Case 1 failure mode in
 *   EXSC-248).
 *
 * Read-only on-chain; writes only to MongoDB. Safe to call regardless of
 * whether the caller is a Safe owner.
 */

import { isTronNetworkKey } from '@lifi/tron-devkit'
import { consola } from 'consola'
import { type Collection } from 'mongodb'
import {
  createPublicClient,
  decodeEventLog,
  http,
  TransactionReceiptNotFoundError,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'

import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

import { SAFE_EVENTS_ABI, SAFE_SINGLETON_ABI } from './config'
import { NONCE_CONSUMING_STATUSES, type ISafeTxDocument } from './safe-utils'
import { enqueueTimelockOpIfApplicable } from './timelock-queue'

/** Grace period before a `submitted` row with no receipt is sent back to `pending`. */
export const SUBMITTED_GRACE_MS = 10 * 60 * 1000 // 10 minutes

/** Default block range scanned by Sweep B. Most public RPCs cap getLogs at 10k blocks. */
export const RECONCILE_LOOKBACK_BLOCKS = 10_000n

export interface IReconcileResult {
  /** Submitted rows promoted to executed. */
  promoted: number
  /** Submitted rows marked reverted. */
  reverted: number
  /** Submitted rows sent back to pending after grace window. */
  demoted: number
  /** Submitted rows with receipts not yet available (left as submitted). */
  awaiting: number
  /** Pending rows back-filled from on-chain logs in Sweep B. */
  backfilledExecuted: number
  /** Pending rows back-filled as reverted from on-chain logs in Sweep B. */
  backfilledReverted: number
}

export interface IReconcileOptions {
  graceMs?: number
  lookbackBlocks?: bigint
  /**
   * Override for the timelock-queue upsert. Defaults to the real
   * `enqueueTimelockOpIfApplicable`. Exposed so tests can spy on the call
   * without standing up a MongoDB instance for the queue cluster.
   */
  enqueueTimelockOpFn?: typeof enqueueTimelockOpIfApplicable
}

/**
 * Reconcile MongoDB Safe-tx rows for one network against on-chain reality.
 *
 * @param pendingTransactions - MongoDB collection of Safe tx documents.
 * @param publicClient - viem client for the target chain (read-only use).
 * @param network - Network key (lowercased internally).
 * @param chainId - EVM chain id.
 * @param safeAddress - Safe contract address on this network.
 * @param onChainNonce - Current Safe nonce read from `publicClient` by caller.
 * @param options - Optional grace window and Sweep B block lookback.
 * @returns Counts of state transitions performed by this run.
 */
export async function reconcileSubmittedSafeTxs(
  pendingTransactions: Collection<ISafeTxDocument>,
  publicClient: PublicClient,
  network: string,
  chainId: number,
  safeAddress: Address,
  onChainNonce: bigint,
  options?: IReconcileOptions
): Promise<IReconcileResult> {
  const result: IReconcileResult = {
    promoted: 0,
    reverted: 0,
    demoted: 0,
    awaiting: 0,
    backfilledExecuted: 0,
    backfilledReverted: 0,
  }

  // Reconciliation relies on viem's EVM read API; Tron uses a different
  // protocol and is intentionally out of scope (matches the write-time
  // policy in confirm-safe-tx, which marks Tron rows executed eagerly).
  const networkKey = network.toLowerCase()
  if (isTronNetworkKey(networkKey)) return result

  const graceMs = options?.graceMs ?? SUBMITTED_GRACE_MS
  const lookbackBlocks = options?.lookbackBlocks ?? RECONCILE_LOOKBACK_BLOCKS
  const enqueueFn =
    options?.enqueueTimelockOpFn ?? enqueueTimelockOpIfApplicable

  await sweepA(
    pendingTransactions,
    publicClient,
    networkKey,
    chainId,
    safeAddress,
    graceMs,
    enqueueFn,
    result
  )

  const expectedNonce = await computeExpectedNonce(
    pendingTransactions,
    networkKey,
    chainId,
    safeAddress
  )

  if (onChainNonce <= expectedNonce) return result

  consola.warn(
    `[${network}] Reconcile: detected on-chain nonce gap of ${
      onChainNonce - expectedNonce
    } (chain=${onChainNonce}, db-expected=${expectedNonce}); scanning Safe execution logs`
  )

  await sweepB(
    pendingTransactions,
    publicClient,
    networkKey,
    chainId,
    safeAddress,
    lookbackBlocks,
    enqueueFn,
    result
  )

  return result
}

export interface IReconcileAllOptions extends IReconcileOptions {
  /**
   * Restrict the sweep to a single network. Sweeps every network with
   * `submitted` rows when omitted.
   */
  network?: string
  /**
   * RPC URL override for the read-only client. Honored only by the default
   * client factory and only meaningful for a single-network sweep (one URL
   * cannot serve every chain); ignored when `publicClientFactory` is supplied.
   */
  rpcUrl?: string
  /**
   * Builds a read-only public client for a network. Injectable for tests;
   * defaults to a viem client using `rpcUrl` when set, else the RPC from
   * `networks.json`.
   */
  publicClientFactory?: (network: string) => PublicClient
  /**
   * Reads the Safe's on-chain nonce. Injectable for tests; defaults to a
   * `nonce()` contract read.
   */
  readSafeNonce?: (
    client: PublicClient,
    safeAddress: Address
  ) => Promise<bigint>
}

/** Builds a read-only viem client for a network, honoring an optional RPC override. */
function buildReadOnlyClient(network: string, rpcUrl?: string): PublicClient {
  return createPublicClient({
    chain: getViemChainForNetworkName(network),
    transport: http(rpcUrl),
  }) as PublicClient
}

/** Reads a Safe's current on-chain nonce via the standard `nonce()` view. */
async function defaultReadSafeNonce(
  client: PublicClient,
  safeAddress: Address
): Promise<bigint> {
  return client.readContract({
    address: safeAddress,
    abi: SAFE_SINGLETON_ABI,
    functionName: 'nonce',
  })
}

/**
 * Coverage key identifying a single Safe on a chain. Producers and consumers of
 * the startup-sweep coverage set MUST use this so an in-loop reconcile is
 * skipped only for the exact `(network, chainId, safeAddress)` that was swept —
 * never for a sibling Safe on the same network.
 *
 * @param network - Network name (case-insensitive).
 * @param chainId - Chain ID.
 * @param safeAddress - Safe address (case-insensitive).
 * @returns A normalized composite key.
 */
export function reconcileCoverageKey(
  network: string,
  chainId: number,
  safeAddress: Address
): string {
  return `${network.toLowerCase()}:${chainId}:${safeAddress.toLowerCase()}`
}

/**
 * Reconciles every network that has `submitted` Safe-tx rows, independent of
 * the pending-only network selection in confirm-safe-tx.
 *
 * Closes the gap where a network whose only row is `submitted` (no sibling
 * `pending` proposal) is never passed to `reconcileSubmittedSafeTxs` and stays
 * stuck — its timelock op never enqueued for auto-execution. Each group runs
 * the full reconcile (Sweep A + Sweep B), so the caller may skip a redundant
 * in-loop reconcile for any returned network.
 *
 * A network can host more than one Safe, so rows are grouped by
 * `(network, chainId, safeAddress)` and reconciled per group. Per-group
 * failures are logged and skipped so one unreachable RPC cannot abort the run.
 * Read-only on-chain; writes only to MongoDB; does not require Safe ownership.
 *
 * @param pendingTransactions - Safe tx collection.
 * @param options - Optional network filter and injectable client/nonce/enqueue seams.
 * @returns `reconcileCoverageKey` values for each Safe that was successfully swept.
 */
export async function reconcileAllSubmittedSafeTxs(
  pendingTransactions: Collection<ISafeTxDocument>,
  options?: IReconcileAllOptions
): Promise<Set<string>> {
  const clientFactory =
    options?.publicClientFactory ??
    ((network: string) => buildReadOnlyClient(network, options?.rpcUrl))
  const nonceReader = options?.readSafeNonce ?? defaultReadSafeNonce
  const networkFilter = options?.network?.toLowerCase()

  const submittedRows = await pendingTransactions
    .find({ status: { $eq: 'submitted' } })
    .toArray()

  const groups = new Map<
    string,
    { network: string; chainId: number; safeAddress: Address }
  >()
  for (const row of submittedRows) {
    const network = row.network.toLowerCase()
    if (networkFilter && network !== networkFilter) continue
    if (isTronNetworkKey(network)) continue
    const safeAddress = row.safeAddress as Address
    const key = reconcileCoverageKey(network, row.chainId, safeAddress)
    if (!groups.has(key))
      groups.set(key, { network, chainId: row.chainId, safeAddress })
  }

  const covered = new Set<string>()
  for (const [key, { network, chainId, safeAddress }] of groups)
    try {
      const client = clientFactory(network)
      const onChainNonce = await nonceReader(client, safeAddress)
      await reconcileSubmittedSafeTxs(
        pendingTransactions,
        client,
        network,
        chainId,
        safeAddress,
        onChainNonce,
        options
      )
      covered.add(key)
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      consola.warn(`[${network}] Startup reconcile failed: ${errorMsg}`)
    }

  return covered
}

/**
 * Sweep A — resolve every `submitted` row from its receipt.
 *
 * Mutates `result` in place with the count of transitions performed.
 */
async function sweepA(
  pendingTransactions: Collection<ISafeTxDocument>,
  publicClient: PublicClient,
  networkKey: string,
  chainId: number,
  safeAddress: Address,
  graceMs: number,
  enqueueFn: typeof enqueueTimelockOpIfApplicable,
  result: IReconcileResult
): Promise<void> {
  const submittedRows = await pendingTransactions
    .find({
      network: { $eq: networkKey },
      chainId: { $eq: chainId },
      safeAddress: { $eq: safeAddress },
      status: { $eq: 'submitted' },
      executionHash: { $exists: true },
    })
    .toArray()

  if (submittedRows.length === 0) return

  const now = Date.now()
  for (const row of submittedRows) {
    if (!row.executionHash) continue
    const status = await safeGetReceiptStatus(
      publicClient,
      row.executionHash as Hex
    )
    // Distinguish "tx truly absent on-chain" from "RPC failed to answer".
    // Only the former — past the grace window — is safe to demote, because
    // a transient RPC error during a real in-flight tx would otherwise free
    // the nonce for reuse and reintroduce the GS026 race this PR fixes.
    if (status === 'rpc_error') {
      result.awaiting++
      consola.warn(
        `[${networkKey}] Reconcile: receipt lookup failed for ${row.executionHash}; leaving ${row.safeTxHash} as submitted`
      )
      continue
    }
    if (status === 'missing') {
      const submittedAtMs = row.submittedAt
        ? new Date(row.submittedAt).getTime()
        : 0
      if (now - submittedAtMs > graceMs) {
        const droppedHash = row.executionHash
        await pendingTransactions.updateOne(
          { safeTxHash: { $eq: row.safeTxHash } },
          {
            $set: { status: 'pending' },
            $unset: { executionHash: '', submittedAt: '' },
          }
        )
        result.demoted++
        consola.warn(
          `[${networkKey}] Reconcile: tx ${droppedHash} not found past grace; ${row.safeTxHash} sent back to pending`
        )
      } else result.awaiting++

      continue
    }
    if (status === 'success') {
      await pendingTransactions.updateOne(
        { safeTxHash: { $eq: row.safeTxHash } },
        { $set: { status: 'executed' } }
      )
      result.promoted++
      consola.success(
        `[${networkKey}] Reconcile: ${row.safeTxHash} confirmed on-chain → executed`
      )
      // Issue the timelock-queue upsert that was deferred at execution
      // time. The helper short-circuits for non-scheduleBatch calldata
      // and is idempotent on (network, operationId).
      await enqueueFn(
        row.safeTx.data.data as Hex,
        row.safeTx.data.to as Address,
        row.safeTxHash,
        row.executionHash as Hex,
        chainId,
        networkKey
      )
    } else {
      await pendingTransactions.updateOne(
        { safeTxHash: { $eq: row.safeTxHash } },
        { $set: { status: 'reverted' } }
      )
      result.reverted++
      consola.error(
        `[${networkKey}] Reconcile: ${row.safeTxHash} reverted on-chain — flagged for review`
      )
    }
  }
}

/**
 * Sweep B — scan recent ExecutionSuccess/ExecutionFailure logs on the Safe
 * and back-fill any `pending` row whose Safe hash matches an event topic.
 */
async function sweepB(
  pendingTransactions: Collection<ISafeTxDocument>,
  publicClient: PublicClient,
  networkKey: string,
  chainId: number,
  safeAddress: Address,
  lookbackBlocks: bigint,
  enqueueFn: typeof enqueueTimelockOpIfApplicable,
  result: IReconcileResult
): Promise<void> {
  let latestBlock: bigint
  try {
    latestBlock = await publicClient.getBlockNumber()
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    consola.warn(
      `[${networkKey}] Reconcile: getBlockNumber failed (${msg}); skipping back-fill`
    )
    return
  }

  const fromBlock =
    latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n

  let logs: Awaited<ReturnType<PublicClient['getLogs']>>
  try {
    logs = await publicClient.getLogs({
      address: safeAddress,
      events: SAFE_EVENTS_ABI,
      fromBlock,
      toBlock: 'latest',
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    consola.warn(
      `[${networkKey}] Reconcile: getLogs failed (${msg}); skipping back-fill`
    )
    return
  }

  for (const log of logs) {
    let decoded
    try {
      decoded = decodeEventLog({
        abi: SAFE_EVENTS_ABI,
        data: log.data,
        topics: log.topics,
      })
    } catch {
      continue
    }
    // Skip logs from txs still in the mempool — log.transactionHash is
    // populated only once the log is included in a block.
    if (log.transactionHash === null) continue
    const safeTxHash = (decoded.args as { txHash: Hex }).txHash
    const isSuccess = decoded.eventName === 'ExecutionSuccess'

    // Read the row first so we have access to its calldata for the
    // timelock enqueue below. The status:'pending' filter doubles as the
    // "did we actually back-fill anything?" guard.
    const candidate = await pendingTransactions.findOne({
      safeTxHash: { $eq: safeTxHash },
      network: { $eq: networkKey },
      chainId: { $eq: chainId },
      status: { $eq: 'pending' },
    })
    if (!candidate) continue

    await pendingTransactions.updateOne(
      { safeTxHash: { $eq: safeTxHash } },
      {
        $set: {
          status: isSuccess ? 'executed' : 'reverted',
          executionHash: log.transactionHash,
          submittedAt: new Date(),
        },
      }
    )
    if (isSuccess) {
      result.backfilledExecuted++
      consola.success(
        `[${networkKey}] Reconcile: back-filled ${safeTxHash} → executed (tx ${log.transactionHash})`
      )
      // Same deferred enqueue as Sweep A: the schedule call ran
      // on-chain but the queue upsert never happened because the script
      // lost the hash at the time of execution.
      await enqueueFn(
        candidate.safeTx.data.data as Hex,
        candidate.safeTx.data.to as Address,
        safeTxHash,
        log.transactionHash,
        chainId,
        networkKey
      )
    } else {
      result.backfilledReverted++
      consola.error(
        `[${networkKey}] Reconcile: back-filled ${safeTxHash} → reverted (tx ${log.transactionHash})`
      )
    }
  }
}

/**
 * Compute the on-chain nonce expected from MongoDB state: highest consumed
 * (see {@link NONCE_CONSUMING_STATUSES} — `executed` only; a `reverted` tx
 * rolls back its `nonce++` and does NOT consume the nonce) nonce + 1, plus the
 * count of in-flight (`submitted`) rows. If the chain's actual nonce exceeds
 * this, at least one execution was not recorded in the DB and Sweep B should
 * run. Counting `reverted` here would inflate the expected nonce and mask a
 * real gap in the revert → re-execute → lost-hash case, skipping Sweep B's
 * back-fill.
 */
async function computeExpectedNonce(
  pendingTransactions: Collection<ISafeTxDocument>,
  networkKey: string,
  chainId: number,
  safeAddress: Address
): Promise<bigint> {
  const [highestConsumed] = await pendingTransactions
    .find({
      network: { $eq: networkKey },
      chainId: { $eq: chainId },
      safeAddress: { $eq: safeAddress },
      status: { $in: [...NONCE_CONSUMING_STATUSES] },
    })
    .sort({ 'safeTx.data.nonce': -1 })
    .limit(1)
    .toArray()

  const maxConsumed =
    highestConsumed !== undefined
      ? BigInt(highestConsumed.safeTx.data.nonce)
      : -1n

  const remainingSubmitted = await pendingTransactions.countDocuments({
    network: { $eq: networkKey },
    chainId: { $eq: chainId },
    safeAddress: { $eq: safeAddress },
    status: { $eq: 'submitted' },
  })

  const consumedHead = maxConsumed >= 0n ? maxConsumed + 1n : 0n
  return consumedHead + BigInt(remainingSubmitted)
}

/**
 * Distinguish "tx is not on-chain" from "RPC failed to answer". viem throws
 * `TransactionReceiptNotFoundError` only when the node confirms the hash is
 * unknown; any other error means the lookup itself failed and the row's
 * true state is still unknown.
 */
async function safeGetReceiptStatus(
  publicClient: PublicClient,
  hash: Hex
): Promise<'success' | 'reverted' | 'missing' | 'rpc_error'> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    return receipt.status
  } catch (err: unknown) {
    if (err instanceof TransactionReceiptNotFoundError) return 'missing'
    return 'rpc_error'
  }
}
