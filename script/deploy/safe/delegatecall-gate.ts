/**
 * Refuses a Safe proposal whose `operation` is not `Call`, on that field alone.
 *
 * A `DelegateCall` runs the code at its target against the Safe's own storage
 * whatever selector the calldata carries, so reading the decoded calldata and
 * finding it harmless says nothing about what it will do. The sign-time
 * codehash gate decides what to vouch for by decoding calldata — `diamondCut`
 * Add/Replace targets and the cut's `_init` — and therefore cannot see this
 * shape at all.
 *
 * The check is sited at confirm time rather than at propose time because
 * `confirm-safe-tx.ts` signs rows read out of MongoDB, which can be created
 * outside this repository: what our own builders emit constrains our builders,
 * not the queue.
 */

import { OperationTypeEnum } from './safe-utils'

export interface IDelegateCallVerdict {
  /** True when this proposal must not be signed or executed. */
  refuses: boolean
  /** One line a signer can act on. Empty only when nothing is refused. */
  reason: string
}

/**
 * The minimum shape this gate reads, and it must come off the struct that gets
 * signed — `safeTransaction.data`, never the stored `safeTx` row.
 *
 * `operation` is part of the EIP-712 struct the signature covers, so a verdict
 * about any other copy of it is a verdict about a value the signature does not
 * commit to. The two copies are not interchangeable here even in principle:
 * `SafeClient.createTransaction` normalises an absent operation to `Call`, so
 * for a row that never carried the field the row and the struct give
 * **opposite** answers.
 *
 * Typed `number | undefined` rather than the enum because the field reaches the
 * struct through a cast, so it can hold anything at runtime whatever it is
 * declared as.
 */
export interface ISignedOperation {
  operation?: number
}

/**
 * Renders a value with its type, so a refusal cannot describe `1n` or `'1'` as
 * "neither Call nor DelegateCall".
 * @param value - whatever the operation field held
 * @returns The value, and its type when that is the surprising part
 */
const describe = (value: unknown): string =>
  typeof value === 'number' || value === undefined
    ? String(value)
    : `${String(value)} (${typeof value})`

/**
 * Judges a proposal's `operation` field.
 *
 * Only the number `0` permits a signature. `==` would accept `'0'` and `0n`,
 * values nothing in this repository writes, so identity is the test.
 * @param data - `data` off the struct that gets signed, never the stored row
 * @returns Whether to refuse, and the reason a signer reads
 */
export const evaluateDelegateCallGate = (
  data: ISignedOperation | null | undefined
): IDelegateCallVerdict => {
  const operation = data?.operation

  if (operation === OperationTypeEnum.Call)
    return { refuses: false, reason: '' }

  if (operation === OperationTypeEnum.DelegateCall)
    return {
      refuses: true,
      reason:
        "This proposal is a delegatecall (operation = 1). It runs the code at its target address against this Safe's own storage, whatever function the calldata appears to call — so the decoded calldata says nothing about what it will do. No proposal path in this repository builds one. Refusing on the operation field alone.",
    }

  // Everything else, an absent field included. Not reachable through the
  // mandated source, because `createTransaction` normalises absence to `Call`
  // before the struct exists — so this is a floor, not a live catch, and is
  // deliberately not described as catching a missing operation. The row losing
  // the field is a real gap and is not covered here or anywhere: it happens one
  // frame up and is invisible by the time a signature is offered.
  return {
    refuses: true,
    reason: `This proposal's operation field is ${describe(
      operation
    )}, and only the number 0 (Call) may be signed. A delegatecall runs its target against this Safe's own storage, so a value that is not exactly Call cannot be assumed to be one — a 1 or a 0 of the wrong type included, which nothing in this repository writes. Refusing.`,
  }
}

const RED = `${String.fromCharCode(27)}[31m`
const RESET = `${String.fromCharCode(27)}[0m`

/**
 * The lines a signer sees. Empty for a plain call — silence is reserved for
 * "there was nothing to refuse", so an operator never learns to scroll past it.
 * @param verdict - what `evaluateDelegateCallGate` decided
 * @returns Zero or more display lines
 */
export const renderDelegateCallGate = (
  verdict: IDelegateCallVerdict
): string[] =>
  verdict.refuses ? [`${RED}⛔ REFUSED ${verdict.reason}${RESET}`] : []

/**
 * Throws unless the proposal may be signed **or executed**.
 *
 * Named for neither route deliberately. Execution needs no signature of ours —
 * a row already carrying the threshold is broadcast without the signer being
 * consulted — so a name mentioning signing invites wiring this into the sign
 * funnel alone and leaving the execute-only routes open.
 * @param verdict - what `evaluateDelegateCallGate` decided
 * @throws When the proposal must not proceed
 */
export const assertProposalOperationPermitted = (
  verdict: IDelegateCallVerdict
): void => {
  if (!verdict.refuses) return

  throw new Error(
    `Operation gate: this transaction will not proceed. ${verdict.reason} Nothing has been signed or executed.`
  )
}
