/**
 * Puts the timelock cancel-decision matrix on the executor's reverting rows.
 *
 * Import this from `execute-pending-timelock-tx.ts`. The matrix decides between
 * execute / cancel / hold / block for one queued operation; this module turns
 * what the executor already knows about a row into that matrix's input, and
 * names the one leg the executor cannot supply.
 *
 * ## Why the reverting path, and why it does not gate
 *
 * Two constraints fix the placement.
 *
 * The matrix reports `integrity` from a re-derivation of the attested build at
 * every signed address. Nothing at execute time does that today, so the leg is
 * `unsupported` — and `unsupported` short-circuits to `hold` with a `page`
 * before any other branch is reached. Letting the verdict drive the action
 * would therefore hold *every* operation on *every* pass and page for each one,
 * which is why this is reported and not enforced. The comparison that makes
 * the report worth reading is the identity leg, which is real: the executor
 * asks the controller for the id its own call list hashes to and compares it
 * with the id the row was scheduled under.
 *
 * The healthy path is also the wrong place to ask the question. An operation
 * that executes cleanly has nothing for a cancel matrix to decide. A row whose
 * `executeBatch` has reverted does: the executor currently blocks it on a
 * count alone, and the matrix is the thing that can say whether blocking is the
 * right answer or whether the row has diverged and should be cancelled.
 *
 * Promoting this to drive the action needs the integrity leg first. Until then
 * the decision is printed next to the block the executor already applies, so a
 * divergence it can see is on the operator's screen rather than in a module
 * nobody calls.
 */

import {
  evaluateCancelDecision,
  type ICancelDecision,
  type ICancelDecisionInput,
  type TProvingLegOutcome,
} from './timelock-cancel-decision'

/** Everything the executor knows about one reverting row. */
export interface ITimelockCancelSignals {
  /** The id the row was scheduled under. */
  scheduledOperationId: string
  /**
   * The id the controller hashes this row's own call list to, or undefined when
   * that read could not be made.
   *
   * Read from the controller rather than recomputed here, so the comparison
   * cannot drift from the contract's own hashing.
   */
  recomputedOperationId: string | undefined
  operationState: ICancelDecisionInput['operationState']
  cancellerAuthority: ICancelDecisionInput['cancellerAuthority']
  deploymentRecord: ICancelDecisionInput['deploymentRecord']
  signTimeVerdictRecord: ICancelDecisionInput['signTimeVerdictRecord']
  revertAttempts: number
  revertBlockThreshold: number
}

/**
 * Compares the id a row was scheduled under with the one its call list hashes
 * to.
 *
 * An unread recomputation is `error`, never `match`: the two ids failing to be
 * compared is not the two ids agreeing, and `error` reaches a non-destructive
 * verdict while `match` is one of the four affirmative legs a clean execution
 * needs.
 *
 * @param signals - The scheduled id and the recomputed one.
 * @returns Whether the ids agree, disagree, or could not be compared.
 */
export const gradeOperationIdentity = (
  signals: Pick<
    ITimelockCancelSignals,
    'scheduledOperationId' | 'recomputedOperationId'
  >
): TProvingLegOutcome => {
  if (signals.recomputedOperationId === undefined) return 'error'

  return signals.recomputedOperationId.trim().toLowerCase() ===
    signals.scheduledOperationId.trim().toLowerCase()
    ? 'match'
    : 'mismatch'
}

/**
 * Builds the matrix's input from what the executor holds.
 *
 * `executability` is `would-revert` rather than the result of a simulation: the
 * row is here because its `executeBatch` reverted on chain, which is the
 * observed form of the thing a simulation only predicts.
 *
 * @param signals - What the executor knows about this row.
 * @returns The input `evaluateCancelDecision` grades.
 */
export const buildCancelDecisionInput = (
  signals: ITimelockCancelSignals
): ICancelDecisionInput => ({
  // No execute-time re-derivation of the attested build exists, so this leg is
  // declared absent rather than reported as a passing comparison.
  integrity: 'unsupported',
  opIdentity: gradeOperationIdentity(signals),
  // Nothing here produced a divergence verdict from an anchor, so the matrix
  // must not treat an identity mismatch as proven and cancel on it.
  verdictProvenance: 'unknown',
  agreeingProviders: 0,
  executability: 'would-revert',
  deploymentRecord: signals.deploymentRecord,
  signTimeVerdictRecord: signals.signTimeVerdictRecord,
  operationState: signals.operationState,
  cancellerAuthority: signals.cancellerAuthority,
  revertAttempts: signals.revertAttempts,
  revertBlockThreshold: signals.revertBlockThreshold,
})

/**
 * The matrix's verdict on one reverting row.
 *
 * Report-only by construction: the caller prints this and takes its own action.
 * See this module's header for why the verdict does not gate execution.
 *
 * @param signals - What the executor knows about this row.
 * @returns The action the matrix would take, its reason, and the operator line.
 */
export const decideRevertedOperation = (
  signals: ITimelockCancelSignals
): ICancelDecision => evaluateCancelDecision(buildCancelDecisionInput(signals))

/**
 * The decision as a line the operator reads next to the block the executor
 * applies.
 *
 * Names the verdict as a recommendation, because it is not what the executor
 * did: a line that read as an action taken would have an operator looking for a
 * cancel that never happened.
 *
 * @param decision - What the matrix decided.
 * @param operationId - The row the decision is about.
 * @returns One line.
 */
export const renderCancelRecommendation = (
  decision: ICancelDecision,
  operationId: string
): string =>
  `Cancel matrix on ${operationId}: would ${decision.reason} → ${decision.action} (${decision.detail})`
