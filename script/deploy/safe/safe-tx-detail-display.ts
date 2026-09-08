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
 * rewind. Every stored value this block prints is therefore sanitised here,
 * and the two fragments the caller assembles itself — the target and the nonce
 * warning — are sanitised there for the same reason.
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
 * Code points that render as zero width while counting as printable text —
 * U+200D and the Hangul fillers among them.
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
 * The `unknown` fields are read straight off the stored row and are sanitised
 * here. The `string` fields already carry colour codes, so they cannot be
 * sanitised without stripping those, and are interpolated as-is: a stored value
 * may only reach one of them already sanitised by the caller.
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
    // Not `value ?? ''`: an absent field has to stay visibly absent. Blanking
    // it makes a row with no `data` — which is still cast to `Hex` and signed —
    // indistinguishable from one carrying `0x`.
    stored = String(value)
  } catch {
    return {
      text: 'unrenderable',
      notice: color(YELLOW, ' ⚠ sanitised for display — value cannot be shown'),
    }
  }

  const text = sanitizeProvenanceText(stored)

  if (text !== stored) {
    // Lengths in code points, the unit a reader counts: two rows that render
    // identically differ only in this number, which is the whole reason it is
    // printed. Reporting UTF-16 units instead would call a two-emoji value
    // four characters.
    const detail =
      text === ''
        ? 'no printable characters'
        : `stored ${[...stored].length}, shown ${[...text].length}`
    return {
      text,
      notice: color(YELLOW, ` ⚠ sanitised for display — ${detail}`),
    }
  }

  // Nothing needed stripping, and the value can still be hiding from the
  // reader. These code points are printable letters and separators rather than
  // control or formatting characters, so the sanitiser passes them through by
  // design, yet they occupy no width — two rows carrying different values can
  // print the same glyphs. Unicode names the class, so this is a defined set
  // rather than a blocklist that has to be extended each time one is found.
  const hidden = (text.match(DEFAULT_IGNORABLE) ?? []).length
  if (hidden > 0)
    return {
      text,
      notice: color(
        YELLOW,
        ` ⚠ ${hidden} invisible character${
          hidden === 1 ? '' : 's'
        } in a value of ${[...text].length}`
      ),
    }

  return { text, notice: '' }
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
