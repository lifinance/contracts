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

import { consola } from 'consola'
import { type Collection } from 'mongodb'
import { decodeEventLog, type Address, type Hex, type PublicClient } from 'viem'

import { isTronNetworkKey } from '../shared/tron-network-keys'

import { SAFE_EVENTS_ABI } from './config'
import type { ISafeTxDocument } from './safe-utils'

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

  await sweepA(
    pendingTransactions,
    publicClient,
    networkKey,
    chainId,
    safeAddress,
    graceMs,
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
    result
  )

  return result
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
  result: IReconcileResult
): Promise<void> {
  const submittedRows = await pendingTransactions
    .find({
      network: networkKey,
      chainId,
      safeAddress,
      status: 'submitted',
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
    if (!status) {
      const submittedAtMs = row.submittedAt
        ? new Date(row.submittedAt).getTime()
        : 0
      if (now - submittedAtMs > graceMs) {
        await pendingTransactions.updateOne(
          { safeTxHash: row.safeTxHash },
          {
            $set: { status: 'pending' },
            $unset: { executionHash: '', submittedAt: '' },
          }
        )
        result.demoted++
        consola.warn(
          `[${networkKey}] Reconcile: tx ${row.executionHash} not found past grace; ${row.safeTxHash} sent back to pending`
        )
      } else result.awaiting++

      continue
    }
    if (status === 'success') {
      await pendingTransactions.updateOne(
        { safeTxHash: row.safeTxHash },
        { $set: { status: 'executed' } }
      )
      result.promoted++
      consola.success(
        `[${networkKey}] Reconcile: ${row.safeTxHash} confirmed on-chain → executed`
      )
    } else {
      await pendingTransactions.updateOne(
        { safeTxHash: row.safeTxHash },
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
    const update = await pendingTransactions.updateOne(
      {
        safeTxHash,
        network: networkKey,
        chainId,
        status: 'pending',
      },
      {
        $set: {
          status: isSuccess ? 'executed' : 'reverted',
          executionHash: log.transactionHash,
          submittedAt: new Date(),
        },
      }
    )
    if (update.modifiedCount === 0) continue
    if (isSuccess) {
      result.backfilledExecuted++
      consola.success(
        `[${networkKey}] Reconcile: back-filled ${safeTxHash} → executed (tx ${log.transactionHash})`
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
 * (executed or reverted) nonce + 1, plus the count of in-flight (`submitted`)
 * rows. If the chain's actual nonce exceeds this, at least one execution was
 * not recorded in the DB and Sweep B should run.
 */
async function computeExpectedNonce(
  pendingTransactions: Collection<ISafeTxDocument>,
  networkKey: string,
  chainId: number,
  safeAddress: Address
): Promise<bigint> {
  const [highestConsumed] = await pendingTransactions
    .find({
      network: networkKey,
      chainId,
      safeAddress,
      status: { $in: ['executed', 'reverted'] },
    })
    .sort({ 'safeTx.data.nonce': -1 })
    .limit(1)
    .toArray()

  const maxConsumed =
    highestConsumed !== undefined
      ? BigInt(highestConsumed.safeTx.data.nonce)
      : -1n

  const remainingSubmitted = await pendingTransactions.countDocuments({
    network: networkKey,
    chainId,
    safeAddress,
    status: 'submitted',
  })

  const consumedHead = maxConsumed >= 0n ? maxConsumed + 1n : 0n
  return consumedHead + BigInt(remainingSubmitted)
}

async function safeGetReceiptStatus(
  publicClient: PublicClient,
  hash: Hex
): Promise<'success' | 'reverted' | null> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash })
    return receipt.status
  } catch {
    return null
  }
}
