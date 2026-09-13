/**
 * Safe transaction detail block
 *
 * Builds the lines a signer reads immediately before the sign prompt in
 * `confirm-safe-tx.ts`. Every value in the block comes off a MongoDB proposal
 * row, and the rows are not all written by this repository, so each one is
 * rendered through `printable-field` rather than interpolated into the colour
 * codes raw: a field whose own content carries an escape sequence can recolour,
 * erase or repaint the lines around it, and repaint a fabricated block showing
 * a benign target above the prompt that asks whether to sign. Length,
 * invisibles and confusables are handled there too, and each one is reachable
 * through a row carrying no escape sequence at all.
 *
 * The two checks that look like they would remove such characters first —
 * `BigInt()` on the nonce and value, `normalizeAddressForNetwork` on the target
 * — *skip* whitespace rather than refusing it, so an `\r`, `\n` or U+2028 at
 * either end of those fields survives both and reaches a line it can rewind.
 * An escape in the *middle* of them does not: `getAddress` and `BigInt` throw
 * on it in `initializeSafeTransaction`, before anything is displayed, so for
 * those three fields that shape is a failed run rather than a spoofed prompt.
 * `data`, `proposer`, `safeTxHash`, `provenance` and `parkedTaskRefs` have no
 * such coercion anywhere and carry whatever the row holds.
 *
 * So the block takes every stored value unrendered and renders all of them
 * here, including the addresses it composes itself. A caller that cleaned one
 * first would leave this code unable to tell that it had, and so unable to say
 * so — which is the whole of the disclosure it prints.
 *
 * The funnel is closed by the type rather than by review: `color` accepts a
 * `Printable` and nothing produces one but `asPrintable` and `trustedMarkup`,
 * so a field added later as a plain `string` does not compile.
 */

import { normalizeAddressForNetwork } from '../../utils/normalizeAddressStringForViem'

import {
  asPrintable,
  color,
  concatPrintable,
  MAX_PARKED_REFS,
  type Printable,
  trustedMarkup,
  UNBOUNDED,
} from './printable-field'
import { formatClaimLines } from './provenance-display'
import { type IProposalProvenance } from './safe-utils'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'
const BOLD = '\u001b[1m'
const RESET = '\u001b[0m'

/** Width of the label column shared with the provenance lines. */
const LABEL_WIDTH = 17

const EMPTY = trustedMarkup('')

const detailLine = (label: string, value: Printable): string =>
  `    ${`${label}:`.padEnd(LABEL_WIDTH)}${value}`

/** One parked facet removal folded into this proposal. */
export interface IParkedTaskRef {
  readonly facet: unknown
  readonly prUrl: unknown
}

/**
 * What the block renders.
 *
 * Every field carrying a value off the stored row is typed `unknown` and is
 * rendered here. The addresses are taken raw and composed here rather than
 * pre-rendered by the caller, because a caller that sanitises them itself
 * leaves this block unable to tell that it did — and so unable to say so.
 *
 * `toTargetName` and both callbacks are treated as untrusted text all the
 * same: their contents are sanitised where they are interpolated, because a
 * caller that composed one out of the stored row would otherwise route
 * straight past everything above.
 *
 * Two fields are `Printable` instead, and cannot be plain strings:
 * `nonceWarning` and `operationLabel` carry colour codes of their own, which
 * sanitising would strip. Both are built from values that cannot hold a stored
 * string — a chain-read `bigint`, and a value already sanitised by
 * `describeOperationValue` — and requiring the brand puts each of them at a
 * `trustedMarkup` call site the caller has to write. `nonceColor` is typed as a
 * closed set instead, being the only field that lands inside an escape sequence
 * rather than beside one.
 */
export interface ISafeTxDetailInput {
  /**
   * Which network this proposal is for. Never free text: every route into this
   * script resolves it to an active `networks.json` key before a row is shown.
   * The only thing it decides here is what shape counts as an address, so that
   * Tron's base58 is not reported as invalid on the one network that stores it.
   */
  readonly network: string
  /**
   * The Safe this proposal would be signed against, as the signing client is
   * pointed at it. Shown because a signer comparing a proposal against an
   * out-of-band message has no other way to see which Safe they are about to
   * commit — and a row claiming a different one is exactly what
   * `INT-SAFE-ADDRESS` exists to catch.
   */
  readonly safeAddress: unknown
  readonly nonce: unknown
  /**
   * SGR parameter for the nonce. A closed set rather than a string: this is
   * the one field interpolated *inside* an escape sequence rather than beside
   * one, so a free-form value here would be a control sequence, not text.
   */
  readonly nonceColor: '31' | '32' | '33'
  /** Pre-rendered warning appended after the nonce, or empty. */
  readonly nonceWarning: Printable
  /** The target as stored. */
  readonly to: unknown
  /** Name for the target from the repository's deployment records, or empty. */
  readonly toTargetName: string
  /** Renders an address the way this network displays it. */
  readonly formatAddress: (address: string) => string
  /** Explorer link for the sanitised target, or empty when there is none. */
  readonly explorerUrlFor: (address: string) => string
  readonly value: unknown
  /** Pre-rendered operation, already sanitised by `describeOperationValue`. */
  readonly operationLabel: Printable
  /**
   * Whether the signed struct is a plain `Call`.
   *
   * Decides how the operation is painted on the envelope line, and whether the
   * block says that the decode below it describes a call that will not happen.
   * It no longer draws an alarm: gate D grades the operation and
   * `assertProposalOperationPermitted` refuses it, and zone 1 stating what zone
   * 2 is about to judge is the mixing this layout exists to end.
   */
  readonly operationIsCall: boolean
  readonly data: unknown
  /**
   * Whether `--raw` was given, printing the calldata in full.
   *
   * Off, the block states its length and first four bytes instead. The length
   * was previously disclosed by the hex's own visual mass — a wall of it reads
   * as one — and a stated character count carries that disclosure without
   * costing the twenty-odd lines above the claim a signer is here to weigh.
   * The payload stays readable in full, one flag away.
   */
  readonly showRawCalldata?: boolean
  /** The proposer as stored. */
  readonly proposer: unknown
  readonly safeTxHash: unknown
  readonly signatureCount: number
  readonly threshold: number
  readonly canExecute: boolean
  /** Replaces the block's own heading; an empty string drops it entirely. */
  readonly heading?: string
  readonly parkedTaskRefs?: readonly IParkedTaskRef[]
  readonly provenance?: IProposalProvenance
}

/** Renders a stored field inside `code`, with its notice outside the colour. */
const storedField = (
  value: unknown,
  code: string,
  maxChars?: number
): Printable => {
  const { text, notice } = asPrintable(value, maxChars)
  return concatPrintable(color(code, text), trustedMarkup(notice))
}

/**
 * What a caller-supplied renderer returned, reduced to printable text.
 *
 * The callbacks are handed a sanitised address, but what reaches the line is
 * their return value, so a caller that ignored its argument and reached for the
 * stored row would render it raw. Rendering the result costs nothing on a real
 * address and removes that route.
 *
 * A renderer that throws or returns nothing yields `undefined` rather than an
 * empty string. Silently dropping it would leave the decorations that were
 * meant to describe it — a target name, an explorer link — standing beside no
 * address at all, which reads as a stronger claim than the row supports.
 */
const printableFragment = (produce: () => string): Printable | undefined => {
  try {
    // Coerced here rather than inside `asPrintable`, which reports a throwing
    // `toString` as an unrenderable *field*. A fragment that cannot be produced
    // is a different thing: the caller falls back to the stored text, so the
    // throw has to reach the catch below. `processTxs` has no per-network
    // catch, so an escape here costs the operator every remaining network.
    const produced = String(produce())
    const { text, notice } = asPrintable(produced)
    if (text === '') return undefined
    return concatPrintable(text, trustedMarkup(notice))
  } catch {
    return undefined
  }
}

/**
 * Describes a thrown value without being able to throw doing it.
 *
 * The last catch before `processTxs` cannot itself fail, and describing an
 * error means coercing it: reading `.message` runs a getter, and the renderer
 * coerces whatever it is given. A value whose `toString` throws something that
 * is itself unstringifiable — a null-prototype object — defeats both, so the
 * fallback is a constant rather than anything derived from the value.
 */
function describeThrown(error: unknown): Printable {
  try {
    // `String` before `asPrintable`, which would otherwise absorb the throw and
    // report "unrenderable" — a description of a field, not of an error nobody
    // can describe.
    const { text, notice } = asPrintable(
      String(error instanceof Error ? error.message : error)
    )
    return concatPrintable(text, trustedMarkup(notice))
  } catch {
    return trustedMarkup('an error that cannot itself be described')
  }
}

/** Names a fragment that could not be rendered, in the notice's voice. */
const FRAGMENT_UNRENDERABLE = color(
  YELLOW,
  trustedMarkup(
    ' ⚠ shown unformatted — this network produced nothing printable for it'
  )
)

/**
 * How an address renders, and whether the renderer produced nothing printable
 * when there was something to render. On failure the sanitised text is shown
 * unformatted rather than dropped, so the line is never blank.
 *
 * An empty stored value is not a failure: it renders empty because it is empty,
 * and saying the network could not render it would blame the wrong thing and
 * add a line the original display never had.
 */
function renderAddress(
  text: Printable,
  formatAddress: (address: string) => string
): { readonly shown: Printable; readonly failed: boolean } {
  const rendered = printableFragment(() => formatAddress(text))
  if (rendered !== undefined) return { shown: rendered, failed: false }
  return { shown: text, failed: text !== '' }
}

/** Renders a stored address through the network's own display form. */
function formattedAddressField(
  value: unknown,
  formatAddress: (address: string) => string
): Printable {
  const { text, notice } = asPrintable(value)
  const { shown, failed } = renderAddress(text, formatAddress)
  return concatPrintable(
    color(GREEN, shown),
    trustedMarkup(notice),
    failed ? FRAGMENT_UNRENDERABLE : EMPTY
  )
}

/**
 * Whether this network would resolve the text to an address at all.
 *
 * The same call `initializeSafeTransaction` already made on this field, so a
 * row that reaches the prompt and a row this reports on are the same set: it
 * accepts base58 on Tron and address-shaped hex everywhere, and refuses the
 * rest. Shape only — mixed-case hex has its checksum recomputed rather than
 * verified, so this is not a corruption check.
 */
const isAddressForNetwork = (network: string, text: string): boolean => {
  try {
    normalizeAddressForNetwork(network, text)
    return true
  } catch {
    return false
  }
}

/**
 * The target, with its name from the deployment records and its explorer link.
 *
 * Neither is resolved unless the printable text still identifies the address
 * that was stored. Sanitising a corrupt address can produce a *valid* one — a
 * zero-width space between two hex digits simply disappears — and naming that
 * would present a corrupt row as a known contract with a working link, a
 * stronger claim than the row supports and a more convincing one than the same
 * row made before this block existed. Trimmed whitespace is exempt: it cannot
 * change which address this is.
 *
 * Both are dropped too when the address itself will not render, so a name and
 * a link can never stand beside nothing.
 *
 * Identity is not validity: a value that was never an address survives
 * sanitising untouched, and neither callback refuses one — the formatter passes
 * an unrecognised shape through and the explorer builder interpolates whatever
 * it is given. Composing a link out of that produces a real-looking URL for a
 * value no chain holds, so address-ness is checked here rather than inferred
 * from the text having come through intact.
 *
 * What counts as an address is asked of the network rather than assumed to be
 * hex: a Tron row stores base58 and is signed over the hex it resolves to, so
 * a hex-only test would call a valid, signable row invalid — and this is the
 * one notice on the block that must never cry wolf.
 * `formatTimelockScheduleBatch` gates its own `target=` on the same call, so
 * both address checks answer to one rule.
 */
/**
 * The target, split where the line may fold.
 *
 * `head` is the address and everything that qualifies it — notices included,
 * which must never be separated from the value they are about. `decorations`
 * is what the repository adds: the deployment record's name and the explorer
 * link, neither of which changes what is signed, so a fold before them loses
 * nothing.
 */
interface ITargetParts {
  readonly head: Printable
  readonly decorations: Printable
}

function targetParts(input: ISafeTxDetailInput): ITargetParts {
  const { text, identityPreserved, notice } = asPrintable(input.to)
  const { shown, failed } = renderAddress(text, input.formatAddress)
  const addressShaped = isAddressForNetwork(input.network, text)
  const resolvable =
    identityPreserved && !failed && shown !== '' && addressShaped

  const targetName = resolvable
    ? printableFragment(() => input.toTargetName)
    : undefined
  const url = resolvable
    ? printableFragment(() => input.explorerUrlFor(text))
    : undefined
  // Keyed on the notice rather than on `identityPreserved`, which is false both
  // for a value the sanitiser repaired and for one that was never a string —
  // and the second of those is the case this says out loud. An empty notice is
  // what the two have in common when nothing was repaired: the stored value
  // *is* what is shown, it simply was never an address, so "the stored value is
  // not what is shown" below would be the false half of the explanation.
  const neverAnAddress = notice === '' && text !== '' && !addressShaped
  const notAnAddress = neverAnAddress
    ? color(
        YELLOW,
        trustedMarkup(
          ' ⚠ not a valid address — shown as stored, and no explorer link'
        )
      )
    : EMPTY

  // Saying nothing here inverts the meaning. The deployment records did match,
  // and a bare address reads to a signer as "not a contract this repo
  // deployed" — the opposite of what the code concluded, which is that it
  // declined to vouch for a name it could otherwise have printed.
  const withheld =
    !resolvable && !neverAnAddress && input.toTargetName
      ? color(
          YELLOW,
          trustedMarkup(
            ' ⚠ target name withheld — the stored value is not what is shown'
          )
        )
      : EMPTY

  // Built from the undecorated fragments rather than from the pre-spaced ones
  // the single-line form used: on a line of their own that space is an indent
  // nobody asked for. Each keeps its own colour — painting by position gives a
  // link the name's colour on a target the records could not name.
  const parts = [
    targetName === undefined ? undefined : color(YELLOW, targetName),
    url === undefined ? undefined : color(CYAN, url),
  ].filter((part): part is Printable => part !== undefined)

  return {
    head: concatPrintable(
      color(GREEN, shown),
      trustedMarkup(notice),
      failed ? FRAGMENT_UNRENDERABLE : EMPTY,
      notAnAddress,
      withheld
    ),
    decorations:
      parts.length === 0
        ? EMPTY
        : concatPrintable(
            parts[0] as Printable,
            ...(parts[1] === undefined ? [] : [trustedMarkup('  '), parts[1]])
          ),
  }
}

/**
 * Shows the deprecation PR behind each parked facet removal folded into this
 * proposal, so the signer sees why a facet is being removed
 * (DeferredDiamondCleanupQueue.md §6).
 *
 * The element count is bounded as well as each element's length: the array
 * comes off the row, so it can hold as many refs as it likes and scroll the
 * block off the screen without any single field being long.
 */
function parkedLines(refs: readonly IParkedTaskRef[]): string[] {
  const lines = ['    Parked cleanup — origin PRs:']
  for (const ref of refs.slice(0, MAX_PARKED_REFS)) {
    // A ref that is not an object still has to print: the array is stored, so
    // its element shapes are as proposer-controlled as their contents.
    const facet = storedField(ref?.facet, GREEN)
    const prUrl = storedField(ref?.prUrl, CYAN)
    lines.push(`        ${facet} → ${prUrl}`)
  }
  const hidden = refs.length - MAX_PARKED_REFS
  if (hidden > 0)
    lines.push(
      `        ${color(
        YELLOW,
        trustedMarkup(
          `⚠ ${hidden} further parked ref${
            hidden === 1 ? '' : 's'
          } not shown (${refs.length} stored)`
        )
      )}`
    )
  return lines
}

/**
 * The queue position, as a sentence.
 *
 * Arithmetic on the row, not a verdict about the proposal: whether the
 * threshold is met decides what the signer is being asked *for*, which is zone
 * 1's subject. `canExecute` used to be printed beside this as a tick; it is
 * this sentence restated, so it is no longer shown.
 * @param signatureCount - Signatures already stored on the row.
 * @param threshold - Signatures the Safe requires.
 * @returns One sentence naming what this signer's signature would do.
 */
export const describeSignatureState = (
  signatureCount: number,
  threshold: number
): string => {
  const ordinal = (n: number): string => {
    const tens = n % 100
    if (tens >= 11 && tens <= 13) return `${n}th`
    const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th'
    return `${n}${suffix}`
  }

  if (signatureCount >= threshold)
    return `${signatureCount} of ${threshold} · already executable, yours is not needed`
  const next = ordinal(signatureCount + 1)
  // No ordinal in this one: which number it is matters less than that it is the
  // one that makes the proposal executable, and naming both overruns the width.
  if (signatureCount + 1 === threshold)
    return `${signatureCount} of ${threshold} · yours would be the last, making it executable`
  if (signatureCount === 0)
    return `none yet · yours would be the 1st of ${threshold}`
  return `${signatureCount} of ${threshold} · yours would be the ${next} of ${threshold}`
}

/**
 * The question the two blocks above it exist to pose.
 *
 * Printed after the decoded calldata rather than with the block, because the
 * decode is written straight to the console by `formatDecodedTxDataForDisplay`
 * and the question has to close the comparison, not open it.
 */
export const CLAIM_QUESTION: readonly string[] = [
  '',
  `  ${BOLD}DO THESE TWO DESCRIBE THE SAME CHANGE?${RESET}`,
  "      If not, stop. Nothing below this line checks the proposer's words",
  '      against the payload — only you can.',
]

/**
 * The calldata, in full under `--raw` and as a fingerprint otherwise.
 *
 * The fingerprint is measured on the sanitised text, so a row padded with
 * invisibles reports the length a reader would have had to scroll past rather
 * than the length it claims.
 */
const calldataLine = (input: ISafeTxDetailInput): string => {
  if (input.showRawCalldata === true)
    return `      — ${storedField(input.data, GREEN, UNBOUNDED)}`

  const { text, notice } = asPrintable(input.data, UNBOUNDED)

  // A value that is not calldata is shown rather than measured. `asPrintable`
  // stands a sentinel in for a field it could not render, and a length taken
  // from that sentinel would report "12 hex chars, starts unrenderab" — a
  // measurement of the placeholder, printed where the payload goes.
  if (!/^0x[0-9a-fA-F]*$/u.test(text))
    return `      — ${storedField(input.data, GREEN, UNBOUNDED)}`

  const body = text.slice(2)
  const head = text.slice(0, 10)
  return `      — ${concatPrintable(
    color(GREEN, trustedMarkup(`${body.length} hex chars`)),
    trustedMarkup(', starts '),
    color(CYAN, asPrintable(head).text),
    trustedMarkup(notice),
    trustedMarkup(' · --raw for the full hex')
  )}`
}

/** A block heading inside zone 1. */
const blockHeading = (title: string): string[] => [
  '',
  `  ${BOLD}${title}${RESET}`,
]

/**
 * What the payload is, printed under the decode rather than over it.
 *
 * The decode is the answer to "what does this do"; the envelope is where it
 * lands and how big it is. Both were labelled rows above the claim, where they
 * were read before the thing they qualify.
 * @param input - The same input the block above was built from.
 * @returns The footnote lines, in order.
 */
export function buildCalldataFootnote(input: ISafeTxDetailInput): string[] {
  const { head, decorations } = targetParts(input)
  // The value and the target's decorations share the continuation line: a
  // 42-character address plus an operation already fills the first one, and a
  // fold that lands inside the address is the one fold this line must not make.
  const continuation = concatPrintable(
    trustedMarkup('value '),
    storedField(input.value, GREEN),
    String(decorations) === '' ? EMPTY : trustedMarkup(' · '),
    decorations
  )

  return [
    `      ${concatPrintable(
      trustedMarkup('— '),
      color(
        input.operationIsCall ? GREEN : `${BOLD}${RED}`,
        input.operationLabel
      ),
      trustedMarkup(' to '),
      head
    )}`,
    `        ${continuation}`,
    calldataLine(input),
  ]
}

/**
 * Formats the Safe transaction detail block for the signing prompt.
 *
 * Zone 1 states what is being asked for; zone 2 grades it. Nothing here carries
 * a verdict — the operation is named rather than alarmed (gate D grades it and
 * `assertProposalOperationPermitted` refuses it), and the nonce warning stays
 * only because it is the queue state this block is about.
 * @param input - Stored row fields plus the fragments the caller pre-rendered.
 * @returns The lines to print, in order, ending on the calldata heading.
 */
export function buildSafeTxDetailLines(input: ISafeTxDetailInput): string[] {
  const heading = input.heading ?? 'Safe Transaction Details:'
  const lines = [
    ...(heading === '' ? [] : [heading]),
    detailLine(
      'Safe',
      formattedAddressField(input.safeAddress, input.formatAddress)
    ),
    `${detailLine(
      'Nonce',
      storedField(input.nonce, `\u001b[${input.nonceColor}m`)
    )}${input.nonceWarning}`,
    detailLine(
      'Signatures',
      color(
        GREEN,
        trustedMarkup(
          describeSignatureState(input.signatureCount, input.threshold)
        )
      )
    ),
    // Kept as an address rather than folded into the claim's handle: the
    // handle names a person, this names the key that wrote the row, and gate C
    // grades the stored signatures against the owner set rather than against
    // either.
    detailLine(
      'Proposer',
      formattedAddressField(input.proposer, input.formatAddress)
    ),
    detailLine('Safe Tx Hash', storedField(input.safeTxHash, CYAN)),
  ]

  lines.push(...blockHeading('THE PROPOSER SAYS'))

  // Load-bearing, not belt-and-braces. `formatClaimLines` handles its own
  // failures by stringifying what was thrown, so a thrown value that cannot be
  // stringified — a null-prototype object, one whose `toString` throws — makes
  // its handler throw a second time and escape. This catch is the last thing
  // before `processTxs`, which has no per-network catch, so an escape here
  // costs the operator every network left in the run.
  try {
    lines.push(...formatClaimLines(input.provenance))
  } catch (error) {
    lines.push(
      `      ${color(
        YELLOW,
        concatPrintable(
          trustedMarkup('— UNKNOWN — the claim could not be rendered: '),
          describeThrown(error)
        )
      )}`
    )
  }

  lines.push(...blockHeading('THE CALLDATA DOES'))

  // The decode below is built from this payload, and on anything but a Call it
  // describes a call that will not happen: a delegatecall runs the target's own
  // code. Stated here rather than left to zone 2, because without it the block
  // under this heading is a false statement about what the payload does.
  if (!input.operationIsCall)
    lines.push(
      ...[
        `      ${color(
          YELLOW,
          trustedMarkup(
            'the calldata is dressed as the call below. A delegatecall will'
          )
        )}`,
        `      ${color(
          YELLOW,
          trustedMarkup("not run it — it runs the target's own code instead:")
        )}`,
      ]
    )

  // `Array.isArray`, not a length check: a stored document with a `length`
  // property satisfies the latter and then throws on `for...of`, which escapes
  // this function entirely — `processTxs` has no per-network catch, so it would
  // cost the operator every network left in the run.
  if (Array.isArray(input.parkedTaskRefs) && input.parkedTaskRefs.length > 0)
    lines.push(...parkedLines(input.parkedTaskRefs))

  return lines
}
