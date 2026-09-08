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
 * `value`, `nonce` and `to` reach the block already gated: they pass through
 * `BigInt()` and `normalizeAddressForNetwork` in `initializeSafeTransaction`,
 * which throw on a row that is not numeric or not an address. `data` goes
 * through the same function cast to `Hex` with nothing checking it. Sanitising
 * is applied to all of them anyway, because that gate is in another module and
 * a guarantee this block depends on but does not make is one it cannot keep.
 */

import { sanitizeProvenanceText } from '../shared/git-provenance'

import { formatProvenanceLines } from './provenance-display'
import { type IProposalProvenance } from './safe-utils'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'
const RESET = '\u001b[0m'

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
 * The `unknown` fields are read straight off the stored row and are sanitised
 * here. The `string` fields are fragments the caller has already rendered,
 * including this module's own colour codes, so they are interpolated as-is —
 * never pass a stored value through one of those.
 */
export interface ISafeTxDetailInput {
  readonly nonce: unknown
  /** SGR parameter for the nonce, chosen by the caller from nonce status. */
  readonly nonceColor: string
  /** Pre-rendered warning appended after the nonce, or empty. */
  readonly nonceWarning: string
  /** Pre-rendered target: address, optional Tron suffix, optional name. */
  readonly toDisplay: string
  /** Pre-rendered explorer link appended inside the target's colour. */
  readonly toExplorerSuffix: string
  readonly value: unknown
  /** Pre-rendered operation, already sanitised by `describeOperationValue`. */
  readonly operationLabel: string
  readonly data: unknown
  /** The proposer address as the caller formats it for this network. */
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
  /** Appended after the field; empty unless the value had to be changed. */
  readonly notice: string
}

const asPrintable = (value: unknown): IRenderedField => {
  // `String()` throws on a value with no `toString` or one that throws its
  // own; the block still has to render, because the signer needs the rest of
  // it to decide.
  let stored: string
  try {
    stored = String(value ?? '')
  } catch {
    return {
      text: 'unrenderable',
      notice: color(YELLOW, ' ⚠ sanitised for display — value cannot be shown'),
    }
  }

  const text = sanitizeProvenanceText(stored)
  if (text === stored) return { text, notice: '' }

  // Lengths in code points, the unit a reader counts: two rows that render
  // identically differ only in this number, which is the whole reason it is
  // printed. Reporting UTF-16 units instead would call a two-emoji value four
  // characters.
  const storedLength = [...stored].length
  const shownLength = [...text].length
  const detail =
    text === ''
      ? 'no printable characters'
      : `stored ${storedLength}, shown ${shownLength}`

  return { text, notice: color(YELLOW, ` ⚠ sanitised for display — ${detail}`) }
}

/** Renders a stored field inside `code`, with its notice outside the colour. */
const storedField = (value: unknown, code: string): string => {
  const { text, notice } = asPrintable(value)
  return `${color(code, text)}${notice}`
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
    detailLine(
      'To',
      color(GREEN, `${input.toDisplay}${input.toExplorerSuffix}`)
    ),
    detailLine('Value', storedField(input.value, GREEN)),
    detailLine('Operation', color(GREEN, input.operationLabel)),
    detailLine('Data', storedField(input.data, GREEN)),
    detailLine('Proposer', storedField(input.proposer, GREEN)),
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
