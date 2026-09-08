/**
 * Refuses a Safe proposal whose `operation` is `DelegateCall`, on that basis
 * alone.
 *
 * A `DelegateCall` runs its target's code against the Safe's own storage
 * whatever selector the calldata carries. The sign-time codehash gate decides
 * what to vouch for by *decoding calldata* — `diamondCut` Add/Replace targets
 * and the cut's `_init` — so a `DelegateCall` carrying no `diamondCut` is
 * invisible to it by design, and is not therefore safe. This is the same class
 * as the `_init` rule that gate already implements, one level up: a purely
 * subtractive cut carrying init calldata is arbitrary code framed as a
 * deletion, and a `DelegateCall` proposal is arbitrary code framed as a call.
 *
 * **Why refuse rather than verify the target.** Measured across the repo before
 * this was written: every proposal builder hardcodes `Call`
 * (`propose-to-safe.ts` and the six `script/tasks/propose*.ts` batch builders),
 * the Tron path sets no operation and defaults to `Call`, and no path anywhere
 * constructs `operation: 1`. Nothing legitimate produces this shape, so
 * verifying its target would build an address-verification path for traffic
 * that does not exist, and would give a proposer a value to be judged against.
 * Refusing costs one comparison and cannot be widened.
 *
 * **Why at sign time and not at propose time.** "Our builders only emit `Call`"
 * is a statement about our builders, not about the queue. `confirm-safe-tx.ts`
 * reads pending rows out of MongoDB, and a proposal can be created outside this
 * repo entirely — the Safe UI, a teammate's script, a proposer whose key is
 * compromised. Gating the propose path would prove nothing about what a signer
 * is being asked to approve.
 */

/** `Enum.Operation` in Safe's own contracts. Only `Call` is permitted here. */
export enum SafeOperationEnum {
  Call = 0,
  DelegateCall = 1,
}

export interface IDelegateCallVerdict {
  /** True when this proposal must not be signed. */
  refuses: boolean
  /** One line a signer can act on. Empty only when nothing is refused. */
  reason: string
}

/**
 * The minimum shape this gate reads, and it must come off the struct that gets
 * signed.
 *
 * `operation` is part of the EIP-712 struct the signature covers, so reading it
 * from anywhere else — the stored MongoDB row, a re-fetch, a display copy —
 * judges a value the signature does not commit to. That is the defect WP-1.4
 * shipped and it recurred twice more on #2327 and #2329; the caller's contract
 * is to pass `safeTransaction.data`, never `safeTx.data`.
 *
 * Typed `number | undefined` rather than the enum on purpose: the field arrives
 * from Mongo through a cast in `initializeSafeTransaction`, so it can be absent
 * at runtime however it is declared, and a gate that could not represent that
 * would have to trust it.
 */
export interface ISignedOperation {
  operation?: number
}

/**
 * Judges a proposal's `operation` field.
 *
 * Anything that is not exactly `Call` refuses, including a missing value. A
 * `?? 0` here would be a fail-open on precisely the check being made — the
 * field is absent when a row never carried it, and "absent" is not evidence of
 * `Call`.
 * @param data - `data` off the struct that gets signed, never the stored row
 * @returns Whether to refuse, and the reason a signer reads
 */
export const evaluateDelegateCallGate = (
  data: ISignedOperation
): IDelegateCallVerdict => {
  const { operation } = data

  if (operation === SafeOperationEnum.Call)
    return { refuses: false, reason: '' }

  if (operation === undefined)
    return {
      refuses: true,
      reason:
        "This proposal carries no operation field, so whether it is a call or a delegatecall is unknown. A delegatecall runs its target against this Safe's own storage, so the difference is the whole question — and an absent value is not evidence of a plain call. Refusing rather than assuming.",
    }

  if (operation === SafeOperationEnum.DelegateCall)
    return {
      refuses: true,
      reason:
        "This proposal is a delegatecall (operation = 1). It runs the code at its target address against this Safe's own storage, whatever function the calldata appears to call — so reading the decoded calldata and finding it harmless says nothing about what this will do. Nothing in this repository proposes a delegatecall; every proposal path builds a plain call. Refusing on the operation field alone.",
    }

  return {
    refuses: true,
    reason: `This proposal's operation field is ${operation}, which is neither Call (0) nor DelegateCall (1). Safe defines no third operation, so this is a value nobody meant to write, and guessing which of the two it resembles is how a delegatecall gets treated as a call. Refusing.`,
  }
}

/** Rendered ahead of the signer's prompt, in the same red as a refusal. */
const REFUSED = `${String.fromCharCode(27)}[31m⛔ REFUSED${String.fromCharCode(
  27
)}[0m`

/**
 * The lines a signer sees. Empty for a plain call — silence is reserved for
 * "there was nothing to refuse", so an operator never learns to scroll past it.
 * @param verdict - what `evaluateDelegateCallGate` decided
 * @returns Zero or more display lines
 */
export const renderDelegateCallGate = (
  verdict: IDelegateCallVerdict
): string[] => (verdict.refuses ? [`${REFUSED} ${verdict.reason}`] : [])

/**
 * Throws unless the proposal may be signed.
 *
 * Separate from the evaluation so the refusal can be asserted inside the one
 * funnel every signature passes through, rather than by a caller remembering to
 * read a boolean.
 * @param verdict - what `evaluateDelegateCallGate` decided
 * @throws When the proposal must not be signed
 */
export const assertDelegateCallGateAllowsSigning = (
  verdict: IDelegateCallVerdict
): void => {
  if (!verdict.refuses) return

  throw new Error(
    `Operation gate: this transaction will not be signed. ${verdict.reason} Nothing has been signed.`
  )
}
