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
 * The check sits on the signing and execution funnel rather than in the
 * proposal builders, because `confirm-safe-tx.ts` signs rows read out of
 * MongoDB, which can be created outside this repository: what our own builders
 * emit constrains our builders, not the queue.
 */

import { sanitizeProvenanceText } from '../shared/git-provenance'

/** Safe `operation` values. Literals so this module does not import `safe-utils`. */
const CALL = 0
const DELEGATE_CALL = 1

export interface IDelegateCallVerdict {
  /** True when this proposal must not be signed or executed. */
  readonly refuses: boolean
  /** One line a signer can act on. Empty only when nothing is refused. */
  readonly reason: string
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

/** Beyond this the value is a terminal flood, not information. */
const MAX_RENDERED = 80

/**
 * Renders the field's value for an operator to read.
 *
 * Sanitised, because this value is proposer-controlled: it reaches the struct
 * through a cast, so a row can carry a string, and interpolating one raw put
 * ANSI escapes into the signer's terminal — any line printing it, the refusal
 * or the operation field itself, could be recoloured by its own content.
 * Length is carried for strings because
 * sanitising is lossy: `01` and `0\u200b1` both print as `01`, and without it
 * two different malformed rows are indistinguishable from the printed line.
 * @param value - whatever the operation field held
 * @returns A control-character-free rendering, bounded, with the type
 */
export const describeOperationValue = (value: unknown): string => {
  if (value === undefined) return 'absent'
  // Distinct from a value whose characters were all stripped: nothing was ever
  // there to strip.
  if (value === null) return 'null'
  if (typeof value === 'number') return String(value)

  const kind =
    typeof value === 'string'
      ? // Code points, the unit the clip below uses: reporting UTF-16 units
        // instead would call a 100-emoji value 200 chars and clip none of it,
        // which is the disambiguation this length exists to provide.
        `string, ${[...value].length} char${[...value].length === 1 ? '' : 's'}`
      : typeof value

  // `String()` throws on a value with no `toString` (`Object.create(null)`) or
  // one that throws its own; a refusal must still render.
  let rendered: string | undefined
  try {
    rendered = sanitizeProvenanceText(value)
  } catch {
    return `unrenderable (${kind})`
  }

  // Distinct from a throw: this value did render, to nothing. Saying
  // "unrenderable" of a row made entirely of stripped characters would describe
  // the wrong failure.
  if (rendered === '') return `no printable characters (${kind})`

  // Sliced by code point, not by index: cutting mid-pair emits a lone
  // surrogate, and the sanitising above does not strip those — they are not
  // control or formatting characters — so nothing downstream would repair it.
  const points = [...rendered]
  const clipped =
    points.length > MAX_RENDERED
      ? `${points.slice(0, MAX_RENDERED).join('')}…`
      : rendered

  return `${clipped} (${kind})`
}

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

  if (operation === CALL) return { refuses: false, reason: '' }

  if (operation === DELEGATE_CALL)
    return {
      refuses: true,
      reason:
        "This proposal is a delegatecall (operation = 1). It runs the code at its target address against this Safe's own storage, whatever function the calldata appears to call — so the decoded calldata says nothing about what it will do. No proposal path in this repository builds one. Refusing on the operation field alone.",
    }

  // Everything else, an absent field included. Absence cannot arrive through the
  // mandated source: `createTransaction` normalises it to `Call` before the
  // struct exists, so this is a floor rather than a check on a reachable input.
  // The row losing the field is invisible by the time a signature is offered,
  // and closing that belongs one frame up.
  return {
    refuses: true,
    reason: `This proposal's operation field is ${describeOperationValue(
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
