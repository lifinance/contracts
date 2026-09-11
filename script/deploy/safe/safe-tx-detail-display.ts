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

import { isAddress } from 'viem'

import {
  asPrintable,
  color,
  concatPrintable,
  MAX_PARKED_REFS,
  type Printable,
  trustedMarkup,
  UNBOUNDED,
} from './printable-field'
import { formatProvenanceLines } from './provenance-display'
import { type IProposalProvenance } from './safe-utils'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'

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
  readonly data: unknown
  /** The proposer as stored. */
  readonly proposer: unknown
  readonly safeTxHash: unknown
  readonly signatureCount: number
  readonly threshold: number
  readonly canExecute: boolean
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
 */
function toLine(input: ISafeTxDetailInput): Printable {
  const { text, identityPreserved, notice } = asPrintable(input.to)
  const { shown, failed } = renderAddress(text, input.formatAddress)
  // Non-strict: a legitimately lower-case address is not a corrupt one.
  const addressShaped = isAddress(text, { strict: false })
  const resolvable =
    identityPreserved && !failed && shown !== '' && addressShaped

  const targetName = resolvable
    ? printableFragment(() => input.toTargetName)
    : undefined
  const name =
    targetName === undefined
      ? EMPTY
      : concatPrintable(trustedMarkup(' '), color(YELLOW, targetName))

  const url = resolvable
    ? printableFragment(() => input.explorerUrlFor(text))
    : undefined
  const link =
    url === undefined
      ? EMPTY
      : concatPrintable(trustedMarkup(' '), color(CYAN, url))

  // Only when nothing was repaired: a value that lost a character to the
  // sanitiser is described by the notice for that, and "withheld" below says
  // the rest. Here the stored value *is* what is shown — it simply was never
  // an address — so that wording would be the false half of the explanation.
  const neverAnAddress = identityPreserved && text !== '' && !addressShaped
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

  return concatPrintable(
    color(GREEN, concatPrintable(shown, name, link)),
    trustedMarkup(notice),
    failed ? FRAGMENT_UNRENDERABLE : EMPTY,
    notAnAddress,
    withheld
  )
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
 * Formats the Safe transaction detail block for the signing prompt.
 * @param input - Stored row fields plus the fragments the caller pre-rendered.
 * @returns The lines to print, in order.
 */
export function buildSafeTxDetailLines(input: ISafeTxDetailInput): string[] {
  const lines = [
    'Safe Transaction Details:',
    `${detailLine(
      'Nonce',
      storedField(input.nonce, `\u001b[${input.nonceColor}m`)
    )}${input.nonceWarning}`,
    detailLine('To', toLine(input)),
    detailLine('Value', storedField(input.value, GREEN)),
    detailLine('Operation', color(GREEN, input.operationLabel)),
    // The one field left unbounded: it is the payload the signature covers and
    // the only place a signer can read it in full.
    detailLine('Data', storedField(input.data, GREEN, UNBOUNDED)),
    detailLine(
      'Proposer',
      formattedAddressField(input.proposer, input.formatAddress)
    ),
    detailLine('Safe Tx Hash', storedField(input.safeTxHash, CYAN)),
    detailLine(
      'Signatures',
      concatPrintable(
        color(
          GREEN,
          trustedMarkup(`${input.signatureCount}/${input.threshold}`)
        ),
        trustedMarkup(' required')
      )
    ),
    detailLine(
      'Execution Ready',
      input.canExecute
        ? color(GREEN, trustedMarkup('✓'))
        : color(RED, trustedMarkup('✗'))
    ),
  ]

  // `Array.isArray`, not a length check: a stored document with a `length`
  // property satisfies the latter and then throws on `for...of`, which escapes
  // this function entirely — `processTxs` has no per-network catch, so it would
  // cost the operator every network left in the run.
  if (Array.isArray(input.parkedTaskRefs) && input.parkedTaskRefs.length > 0)
    lines.push(...parkedLines(input.parkedTaskRefs))

  // Load-bearing, not belt-and-braces. `formatProvenanceLines` handles its own
  // failures by stringifying what was thrown, so a thrown value that cannot be
  // stringified — a null-prototype object, one whose `toString` throws — makes
  // its handler throw a second time and escape. This catch is the last thing
  // before `processTxs`, which has no per-network catch, so an escape here
  // costs the operator every network left in the run.
  try {
    lines.push(...formatProvenanceLines(input.provenance))
  } catch (error) {
    lines.push(
      detailLine(
        'Provenance',
        color(
          YELLOW,
          concatPrintable(
            trustedMarkup('UNKNOWN — could not be rendered: '),
            describeThrown(error)
          )
        )
      )
    )
  }

  return lines
}
