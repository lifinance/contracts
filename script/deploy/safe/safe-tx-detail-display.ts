/**
 * Safe transaction detail block
 *
 * Builds the lines a signer reads immediately before the sign prompt in
 * `confirm-safe-tx.ts`. Every value in the block comes off a MongoDB proposal
 * row, and the rows are not all written by this repository, so each one is
 * rendered through the sanitiser rather than interpolated into the colour
 * codes raw: a field whose own content carries an escape sequence can recolour,
 * erase or repaint the lines around it, and repaint a fabricated block showing
 * a benign target above the prompt that asks whether to sign.
 *
 * Nothing upstream can be relied on to have removed them first. The two checks
 * that look like they would — `BigInt()` on the nonce and value,
 * `normalizeAddressForNetwork` on the target — *skip* whitespace rather than
 * refusing it, so `\r`, `\n` and U+2028 survive both and reach a line they can
 * rewind.
 *
 * So the block takes every stored value unrendered and sanitises all of them
 * here, including the addresses it composes itself. A caller that cleaned one
 * first would leave this code unable to tell that it had, and so unable to say
 * so — which is the whole of the disclosure below.
 */

import { sanitizeProvenanceText } from '../shared/git-provenance'

import { formatProvenanceLines } from './provenance-display'
import { type IProposalProvenance } from './safe-utils'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'
const RESET = '\u001b[0m'

/**
 * Code points a renderer is meant to pass over rather than draw — U+200D and
 * the Hangul fillers among them. The sanitiser keeps them because they are
 * printable letters and separators, not control or formatting characters, so
 * a value can differ from another only by these and print identically.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu

/** Width of the label column shared with the provenance lines. */
const LABEL_WIDTH = 17

const color = (code: string, text: string): string => `${code}${text}${RESET}`

const detailLine = (label: string, value: string): string =>
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
 * sanitised here. The addresses are taken raw and composed here rather than
 * pre-rendered by the caller, because a caller that sanitises them itself
 * leaves this block unable to tell that it did — and so unable to say so.
 *
 * `toTargetName` and both callbacks are treated as untrusted text all the
 * same: their contents are sanitised where they are interpolated, because a
 * caller that composed one out of the stored row would otherwise route
 * straight past everything above.
 *
 * Two fields are not, and cannot be: `nonceWarning` and `operationLabel` carry
 * colour codes of their own, which sanitising would strip. Both are built from
 * values that cannot hold a stored string — a chain-read `bigint` and a
 * value already sanitised by `describeOperationValue`. `nonceColor` is typed
 * as a closed set instead, being the only field that lands inside an escape
 * sequence rather than beside one.
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
  readonly nonceWarning: string
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
  readonly operationLabel: string
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

/** A stored value reduced to something safe to print. */
interface IRenderedField {
  readonly text: string
  /**
   * True when the printable text still identifies whatever the stored value
   * identified — only leading and trailing whitespace was lost.
   */
  readonly identityPreserved: boolean
  /** Appended after the field; empty unless there is something to report. */
  readonly notice: string
}

const asPrintable = (value: unknown): IRenderedField => {
  // `String()` throws on a value with no `toString` or one that throws its
  // own; the block still has to render, because the signer needs the rest of
  // it to decide.
  let stored: string
  try {
    // Not `value ?? ''`: an absent field has to stay visibly absent. Blanking
    // it makes a row with no `data` — which is still cast to `Hex` and signed —
    // indistinguishable from one carrying `0x`.
    stored = String(value)
  } catch {
    return {
      text: 'unrenderable',
      identityPreserved: false,
      notice: color(YELLOW, ' ⚠ sanitised for display — value cannot be shown'),
    }
  }

  const text = sanitizeProvenanceText(stored)
  const remarks: string[] = []

  if (text !== stored)
    // Counts describe the stored value and what survived sanitising, not the
    // finished line: a network formatter may replace what it is given with an
    // entirely different rendering. They can also be equal, since a newline
    // collapses to a space one for one, which is why the fact of the change is
    // stated separately from the numbers.
    remarks.push(
      text === ''
        ? 'no printable characters'
        : `sanitised for display — stored ${[...stored].length}, printable ${
            [...text].length
          }`
    )

  // Counted on the printable text, not the stored value: a character the
  // sanitiser removed is reported by the remark above, and repeating it here
  // would claim it survived.
  const hidden = (text.match(DEFAULT_IGNORABLE) ?? []).length
  if (hidden > 0)
    remarks.push(
      `${hidden} invisible character${hidden === 1 ? '' : 's'} among ${
        [...text].length
      } printable`
    )

  // Says only what it knows. An earlier version called these "empty", which is
  // a claim about the container: `[' ']` and `[null]` both render as nothing
  // while holding an element.
  if (typeof value === 'object' && value !== null)
    remarks.push(
      `stored as ${
        Array.isArray(value) ? 'an array' : 'an object'
      }, not a string`
    )

  return {
    text,
    // Each condition rules out a different way the glyphs a reader sees can
    // fail to determine the stored value. Anything that was not a string was
    // never an address, absent included — `String(undefined)` is a word, not a
    // target. Trimming the ends is the one repair that cannot change which
    // address this is; an edit inside it can, since a zero-width space between
    // two hex digits simply vanishes. And a surviving invisible character is
    // that same problem without the repair: the sanitiser keeps it by design,
    // so the text and the glyphs disagree.
    identityPreserved:
      typeof value === 'string' && stored.trim() === text && hidden === 0,
    notice: remarks.length > 0 ? color(YELLOW, ` ⚠ ${remarks.join('; ')}`) : '',
  }
}

/** Renders a stored field inside `code`, with its notice outside the colour. */
const storedField = (value: unknown, code: string): string => {
  const { text, notice } = asPrintable(value)
  return `${color(code, text)}${notice}`
}

/**
 * What a caller-supplied renderer returned, reduced to printable text.
 *
 * The callbacks are handed a sanitised address, but what reaches the line is
 * their return value, so a caller that ignored its argument and reached for the
 * stored row would render it raw. Sanitising the result costs nothing on a real
 * address and removes that route.
 *
 * A renderer that throws or returns nothing yields `undefined` rather than an
 * empty string. Silently dropping it would leave the decorations that were
 * meant to describe it — a target name, an explorer link — standing beside no
 * address at all, which reads as a stronger claim than the row supports.
 */
const printableFragment = (produce: () => string): string | undefined => {
  let produced: string
  try {
    produced = produce()
  } catch {
    return undefined
  }
  return sanitizeProvenanceText(produced) || undefined
}

/** Names a fragment that could not be rendered, in the notice's voice. */
const FRAGMENT_UNRENDERABLE = color(
  YELLOW,
  ' ⚠ the address could not be rendered for this network'
)

/** Renders a stored address through the network's own display form. */
function formattedAddressField(
  value: unknown,
  formatAddress: (address: string) => string
): string {
  const { text, notice } = asPrintable(value)
  const rendered = printableFragment(() => formatAddress(text))
  return rendered === undefined
    ? `${color(GREEN, text)}${notice}${FRAGMENT_UNRENDERABLE}`
    : `${color(GREEN, rendered)}${notice}`
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
 */
function toLine(input: ISafeTxDetailInput): string {
  const { text, identityPreserved, notice } = asPrintable(input.to)
  const address = printableFragment(() => input.formatAddress(text))
  const resolvable = identityPreserved && address !== undefined

  const targetName = resolvable
    ? printableFragment(() => input.toTargetName)
    : undefined
  const name = targetName === undefined ? '' : ` ${color(YELLOW, targetName)}`

  const url = resolvable
    ? printableFragment(() => input.explorerUrlFor(text))
    : undefined
  const link = url === undefined ? '' : ` ${color(CYAN, url)}`

  return address === undefined
    ? `${color(GREEN, text)}${notice}${FRAGMENT_UNRENDERABLE}`
    : `${color(GREEN, `${address}${name}${link}`)}${notice}`
}

/**
 * Shows the deprecation PR behind each parked facet removal folded into this
 * proposal, so the signer sees why a facet is being removed
 * (DeferredDiamondCleanupQueue.md §6).
 */
function parkedLines(refs: readonly IParkedTaskRef[]): string[] {
  const lines = ['    Parked cleanup — origin PRs:']
  for (const ref of refs) {
    // A ref that is not an object still has to print: the array is stored, so
    // its element shapes are as proposer-controlled as their contents.
    const facet = storedField(ref?.facet, GREEN)
    const prUrl = storedField(ref?.prUrl, CYAN)
    lines.push(`        ${facet} → ${prUrl}`)
  }
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
    detailLine('Data', storedField(input.data, GREEN)),
    detailLine(
      'Proposer',
      formattedAddressField(input.proposer, input.formatAddress)
    ),
    detailLine('Safe Tx Hash', storedField(input.safeTxHash, CYAN)),
    detailLine(
      'Signatures',
      `${color(GREEN, `${input.signatureCount}/${input.threshold}`)} required`
    ),
    detailLine(
      'Execution Ready',
      input.canExecute ? color(GREEN, '✓') : color(RED, '✗')
    ),
  ]

  if (input.parkedTaskRefs && input.parkedTaskRefs.length > 0)
    lines.push(...parkedLines(input.parkedTaskRefs))

  // Belt-and-braces around a total function: no shape of stored row may cost
  // the operator the rest of the networks in this run.
  try {
    lines.push(...formatProvenanceLines(input.provenance))
  } catch (error) {
    lines.push(
      detailLine(
        'Provenance',
        color(
          YELLOW,
          `UNKNOWN — could not be rendered: ${sanitizeProvenanceText(
            error instanceof Error ? error.message : error
          )}`
        )
      )
    )
  }

  return lines
}
