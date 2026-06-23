/**
 * On-chain confirmation gate for timelock `executeBatch` submissions.
 * Used by `execute-pending-timelock-tx.ts` to decide whether a queue row may
 * be flipped to `executed` after broadcasting an execution transaction.
 */

import { consola } from 'consola'
import type { TransactionReceipt } from 'viem'

import { sleep } from '../../utils/delay'

export type TimelockExecutionConfirmation =
  | 'confirmed'
  | 'reverted'
  | 'unconfirmed'

export interface IConfirmTimelockExecutionParams {
  /** Receipt from the chain caller, when the chain confirmed synchronously. Absent on confirmation timeout and on chains without synchronous receipts (e.g. Tron). */
  receipt?: Pick<TransactionReceipt, 'status'>
  /** Reads `isOperationDone(operationId)` from the timelock controller. */
  isOperationDone: () => Promise<boolean>
  /** Maximum number of on-chain checks before giving up. */
  attempts?: number
  /** Delay between on-chain checks in milliseconds. */
  delayMs?: number
}

const DEFAULT_ATTEMPTS = 10
const DEFAULT_DELAY_MS = 5000 // 5 s between polls (~50 s total) — covers txs that outlive the caller's 30 s receipt wait

/**
 * Confirms whether a submitted `executeBatch` transaction actually executed
 * the timelock operation on-chain.
 *
 * A missing receipt is never treated as success: the operation counts as
 * executed only when `isOperationDone` reports true on-chain. Transient
 * `isOperationDone` errors are retried until attempts are exhausted.
 *
 * @param params - Receipt (if any), the on-chain check, and poll tuning.
 * @returns `reverted` for a failed receipt, `confirmed` once the operation is
 *   done on-chain, otherwise `unconfirmed` (caller must keep the op retryable).
 */
export async function confirmTimelockExecution(
  params: IConfirmTimelockExecutionParams
): Promise<TimelockExecutionConfirmation> {
  const { receipt, isOperationDone } = params
  const attempts = params.attempts ?? DEFAULT_ATTEMPTS
  const delayMs = params.delayMs ?? DEFAULT_DELAY_MS

  if (receipt && receipt.status !== 'success') return 'reverted'

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs)
    try {
      if (await isOperationDone()) return 'confirmed'
    } catch (error) {
      consola.warn(
        `isOperationDone check failed (attempt ${attempt + 1}/${attempts}):`,
        error
      )
    }
  }

  return 'unconfirmed'
}
