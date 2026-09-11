/**
 * Printable field primitive for the signer's prompt
 *
 * Import this to render any value that came off a MongoDB proposal row: it
 * bounds the value's length, strips what a terminal would execute, counts the
 * invisibles and confusables it cannot repair, and returns a notice naming
 * everything it did. A signer who cannot see that a field was repaired cannot
 * tell a normal proposal from a hand-edited one, so nothing here cleans
 * quietly.
 */

import { sanitizeProvenanceText } from '../shared/git-provenance'

/**
 * Text that has been through this module. Branded so a stored value cannot
 * reach a printed line by being typed `string`.
 */
export type Printable = string & { readonly __printable: unique symbol }

/**
 * Bound for every stored field but the calldata. The longest legitimate value
 * in the prompt is a 66-character hash or a PR URL, so beyond this a field is a
 * terminal flood rather than information.
 */
export const MAX_FIELD_CHARS = 120

/**
 * The calldata is deliberately unbounded: it is the payload the signature
 * covers and the only place a signer can read it in full, so clipping it would
 * remove the thing they are being asked to approve. Its length is also its own
 * disclosure — a wall of hex reads as one, where a 66-character field silently
 * grown to 500,000 does not.
 */
export const UNBOUNDED = Number.POSITIVE_INFINITY

/** Most parked refs rendered; the overflow is counted on a line of its own. */
export const MAX_PARKED_REFS = 20

/**
 * Bound for a decoded tuple or array argument, whose element count is as
 * proposer-controlled as each element's contents. Wide enough for the argument
 * shapes that reach this display — an `initFrax`-style pair list, a handful of
 * selectors — so a real proposal still renders whole.
 */
export const MAX_ARG_JSON_CHARS = 2_000

const YELLOW = '\u001b[33m'
const RESET = '\u001b[0m'

/**
 * Code points a renderer is meant to pass over rather than draw — U+200D and
 * the Hangul fillers among them. The sanitiser keeps them because they are
 * printable letters and separators, not control or formatting characters, so
 * a value can differ from another only by these and print identically.
 */
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu

/** Anything outside ASCII; the ignorables above are discounted separately. */
const NON_ASCII = /[^\p{ASCII}]/gu

/**
 * Marks text this repository composed as printable.
 *
 * The only permitted arguments are values derived from a chain read or from
 * something already sanitised, which carry colour codes of their own that
 * sanitising would strip. A stored row value is never one of those.
 * @param text - Repository-composed markup
 * @returns The same text, branded
 */
export const trustedMarkup = (text: string): Printable => text as Printable

/**
 * Wraps printable text in an SGR code.
 * @param code - The escape sequence to open with
 * @param text - Text that has been through this module
 * @returns The wrapped text, still printable
 */
export const color = (code: string, text: Printable): Printable =>
  `${code}${text}${RESET}` as Printable

/**
 * Joins printable parts without losing the brand.
 * @param parts - Printable fragments, in order
 * @returns Their concatenation
 */
export const concatPrintable = (...parts: Printable[]): Printable =>
  parts.join('') as Printable

/**
 * A notice in the same voice as the ones {@link asPrintable} attaches, for a
 * caller that has something to disclose this module cannot know about — that a
 * value is not a valid address for its network, say.
 *
 * Here rather than at the call site so every notice carries the same colour and
 * its own reset, which is what lets it stay legible wherever it is interpolated.
 * @param text - What the signer needs told, without the marker
 * @returns The notice, branded
 */
export const fieldNotice = (text: string): Printable =>
  `${YELLOW} ⚠ ${text}${RESET}` as Printable

/** A stored value reduced to something safe to print. */
export interface IRenderedField {
  readonly text: Printable
  /**
   * True when the printable text still identifies whatever the stored value
   * identified — only leading and trailing whitespace was lost.
   */
  readonly identityPreserved: boolean
  /** Appended after the field; empty unless there is something to report. */
  readonly notice: string
}

/**
 * Reduces one stored value to printable text plus a notice describing every
 * repair it needed.
 * @param value - Whatever the row held, of any type
 * @param maxChars - Code-point bound; `UNBOUNDED` for the calldata
 * @returns The text to print, whether it still identifies the stored value,
 * and the notice to print after it
 */
export const asPrintable = (
  value: unknown,
  maxChars: number = MAX_FIELD_CHARS
): IRenderedField => {
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
      text: 'unrenderable' as Printable,
      identityPreserved: false,
      notice: `${YELLOW} ⚠ sanitised for display — value cannot be shown${RESET}`,
    }
  }

  const sanitized = sanitizeProvenanceText(stored)
  const remarks: string[] = []

  if (sanitized !== stored)
    // Counts describe the stored value and what survived sanitising, not the
    // finished line: a network formatter may replace what it is given with an
    // entirely different rendering. They can also be equal, since a newline
    // collapses to a space one for one, which is why the fact of the change is
    // stated separately from the numbers.
    remarks.push(
      sanitized === ''
        ? 'no printable characters'
        : `sanitised for display — stored ${[...stored].length}, printable ${
            [...sanitized].length
          }`
    )

  // Counted on everything that survived sanitising, including the part a clip
  // below will cut. A character the sanitiser removed is reported by the remark
  // above, and repeating it here would claim it survived — but one that survived
  // is part of the value the signature covers whether or not the line has room
  // to show it, so counting only the shown prefix would under-report what is
  // being signed. The clip remark says how much is off screen.
  const hidden = (sanitized.match(DEFAULT_IGNORABLE) ?? []).length
  if (hidden > 0)
    remarks.push(
      `${hidden} invisible character${hidden === 1 ? '' : 's'} among ${
        [...sanitized].length
      } printable`
    )

  // Discounts the ignorables above so one code point is not reported twice
  // under two different descriptions.
  const confusable = (sanitized.match(NON_ASCII) ?? []).length - hidden
  if (confusable > 0)
    remarks.push(
      `${confusable} non-ASCII character${
        confusable === 1 ? '' : 's'
      } — a letter here can be drawn identically to an ASCII one`
    )

  // Clipped by code point, not by index: cutting mid-pair emits a lone
  // surrogate, which the sanitiser does not strip — it is neither a control
  // nor a formatting character — so nothing downstream would repair it.
  const points = [...sanitized]
  const clipped = points.length > maxChars
  const text = clipped ? points.slice(0, maxChars).join('') : sanitized
  if (clipped)
    remarks.push(
      `clipped for display — stored ${points.length}, shown ${maxChars}`
    )

  // Reports the shape, not emptiness: `[' ']` and `[null]` both render as
  // nothing while holding an element.
  if (typeof value === 'object' && value !== null)
    remarks.push(
      `stored as ${
        Array.isArray(value) ? 'an array' : 'an object'
      }, not a string`
    )

  return {
    text: text as Printable,
    // A byte-level property, not a glyph-level one, for the parts it can
    // decide: it says the printable text is the stored text modulo trimming,
    // which is what `getTargetName` and the explorer link are resolved from.
    // Anything that was not a string was never an address, absent included —
    // `String(undefined)` is a word, not a target. Trimming the ends is the one
    // repair that cannot change which address this is; an edit inside it can,
    // since a zero-width space between two hex digits simply vanishes. A
    // surviving invisible or a confusable is that same problem without the
    // repair, and a clip is a different value outright.
    identityPreserved:
      typeof value === 'string' &&
      stored.trim() === sanitized &&
      hidden === 0 &&
      confusable === 0 &&
      !clipped,
    notice:
      remarks.length > 0 ? `${YELLOW} ⚠ ${remarks.join('; ')}${RESET}` : '',
  }
}

/**
 * One stored value as a single printable run: the text with its notice after
 * it. For callers that interpolate into their own colour codes rather than
 * composing lines through `color`.
 * @param value - Whatever the row held
 * @param maxChars - Code-point bound
 * @returns Printable text with any notice appended
 */
export const printableField = (
  value: unknown,
  maxChars: number = MAX_FIELD_CHARS
): Printable => {
  const { text, notice } = asPrintable(value, maxChars)
  return `${text}${notice}` as Printable
}
