/**
 * Folds the end-of-run reconcile's row statuses into confirm-safe-tx's
 * execution summary and queue outcomes. Kept apart from confirm-safe-tx, which
 * runs its CLI on import, so the bookkeeping can be unit-tested.
 */

import { type INetworkOutcome } from './confirm-safe-tx-ack'
import { type IRunSubmission } from './reconcile'
import { type SafeTxStatus } from './safe-utils'

/** One line of the execution summary's failed or timed-out list. */
export interface IExecutionSummaryEntry {
  chain: string
  safeTxHash: string
  /** The row's `_id` as hex, when the entry came from a row the run executed. */
  rowId?: string | undefined
  error: string
}

/** An execution this run left unconfirmed, with what the summary needs to find it. */
export interface IRunSubmissionRecord extends IRunSubmission {
  proposalKey: string
}

/** The run's summary state; {@link applyRunSubmissionStatuses} mutates it in place. */
export interface IRunSummaryState {
  failed: IExecutionSummaryEntry[]
  timedOut: IExecutionSummaryEntry[]
  outcomes: INetworkOutcome[]
}

/**
 * Removes and returns the first entry for this execution's row found in
 * `lists` — by row, since `safeTxHash` is not unique across rows.
 */
function takeEntry(
  submission: IRunSubmissionRecord,
  lists: IExecutionSummaryEntry[][]
): IExecutionSummaryEntry | undefined {
  const rowId = submission.rowId.toHexString()
  for (const list of lists) {
    const index = list.findIndex((item) => item.rowId === rowId)
    if (index !== -1) return list.splice(index, 1)[0]
  }
  return undefined
}

/**
 * Moves each submission to where the end-of-run reconcile found it: an
 * executed one leaves the failed and timed-out lists and counts as executed in
 * the queue summary, a reverted one is listed as failed, and one whose row is
 * back to `pending` is listed as failed unless it already is — that entry
 * carries the error that left the row pending.
 *
 * @param submissions - This run's unconfirmed executions.
 * @param statuses - Row status per submission, keyed by `rowId.toHexString()`.
 * @param state - The run's summary lists, mutated in place.
 * @returns How many submissions are still `submitted`.
 */
export function applyRunSubmissionStatuses(
  submissions: IRunSubmissionRecord[],
  statuses: Map<string, SafeTxStatus>,
  state: IRunSummaryState
): number {
  let stillSubmitted = 0
  for (const submission of submissions) {
    const status = statuses.get(submission.rowId.toHexString())
    if (status === 'submitted') stillSubmitted++
    else if (status === 'executed') {
      takeEntry(submission, [state.timedOut, state.failed])
      // rollUpQueue keeps the last outcome per proposal, so this supersedes
      // the one recorded when the execution came back unconfirmed.
      const outcome = state.outcomes
        .filter((o) => o.proposalKey === submission.proposalKey)
        .at(-1)
      if (outcome) state.outcomes.push({ ...outcome, executedThisRun: true })
    } else if (status === 'reverted') {
      const entry = takeEntry(submission, [state.timedOut, state.failed])
      if (entry) state.failed.push({ ...entry, error: 'on-chain revert' })
    } else if (status === 'pending') {
      const entry = takeEntry(submission, [state.timedOut])
      if (entry)
        state.failed.push({
          ...entry,
          error: 'row is pending — execution not confirmed on-chain',
        })
    }
  }
  return stillSubmitted
}
