/**
 * The three zones a signer reads, in the order they have to be read: what the
 * proposal is, what the machine already checked, and what is left that only a
 * human can do.
 *
 * Built after walking a rehearsal matrix with a Ledger on 2026-09-12. The data
 * was right and the arrangement was not: the device instructions printed before
 * the checks, and four different modules each spoke their own dialect of red, so
 * "this proposal is dangerous" and "I could not reach an RPC" arrived with the
 * same glyph.
 */

import type { ICheckDefinition, ICheckResult } from './check-ledger'
import { gateLabel, isAcknowledgeable } from './check-ledger'

const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const RED = `${ESC}[31m`
const GREEN = `${ESC}[32m`
const YELLOW = `${ESC}[33m`
const BLUE = `${ESC}[36m`

/**
 * Terminal columns the zones are drawn to.
 *
 * Wide rather than the 76 a terminal is guaranteed to have, because the fold
 * this view fights is not the terminal's — it is this width's. At 76 a claim
 * sentence, a provenance line and an explorer URL each wrapped onto a second
 * line, and the rules separating the three zones were shorter than the text
 * they were meant to divide. The one thing the width must never do is fold an
 * address or a URL mid-token, and every folding path here places tokens whole.
 */
export const VIEW_WIDTH = 140

/**
 * What a signer is being asked to do about a result.
 *
 * Keyed off `status` rather than off which module produced the row, because a
 * signer cannot be expected to know that `rpc-quorum` describes their laptop
 * while `INT-SAFE-ADDRESS` describes the transaction. `fail` is the proposal
 * disagreeing with its anchor; `error` is this run failing to find out.
 */
export type CheckBucket = 'wrong' | 'unchecked' | 'ack' | 'passed' | 'n/a'

interface IBucketStyle {
  heading: string
  glyph: string
  colour: string
}

/**
 * How each bucket prints.
 *
 * No two buckets share a glyph. That is the whole point of the grouping: the
 * previous view used one red stop sign for a tampered Safe address, a reverting
 * payload, a thin RPC set and an unreachable deployment record, and only the
 * wording told them apart.
 */
const BUCKET_STYLE: ReadonlyMap<CheckBucket, IBucketStyle> = new Map([
  [
    'wrong',
    {
      heading: 'THE PROPOSAL IS WRONG — do not sign',
      glyph: '⛔',
      colour: RED,
    },
  ],
  [
    'unchecked',
    {
      heading: 'COULD NOT BE CHECKED — your environment, not the proposal',
      glyph: '?',
      colour: YELLOW,
    },
  ],
  [
    'ack',
    {
      heading: 'NEEDS YOUR ACKNOWLEDGEMENT',
      glyph: '⚠️',
      colour: YELLOW,
    },
  ],
  ['passed', { heading: 'PASSED', glyph: '✅', colour: GREEN }],
  ['n/a', { heading: 'NOT APPLICABLE', glyph: '·', colour: DIM }],
])

/** Reading order: what stops you, then what you must fix, then the rest. */
const BUCKET_ORDER: readonly CheckBucket[] = [
  'wrong',
  'unchecked',
  'ack',
  'passed',
  'n/a',
]

/**
 * Statuses that say the gate had nothing to grade, rather than that it failed
 * to grade.
 *
 * Matched against a set of strings rather than against the `CheckStatus` union,
 * because the ledger's vocabulary is the wider of the two: a gate can record a
 * status this view's checkout does not declare, and the catch-all below reads
 * one it cannot name as an unmade reading. That default is right for a status
 * nothing defines and wrong for one the ledger grades outside both numerators —
 * it turns a gate that correctly stood down into a stop sign the signer cannot
 * clear, on every proposal that installs nothing.
 */
const NOTHING_TO_GRADE_STATUSES: ReadonlySet<string> = new Set([
  'not-applicable',
])

/**
 * What a stood-down gate says when it did not say why.
 *
 * Never blank: a row printing only its title reads as a gate that reported
 * nothing, which is the one thing the manifest above exists to make visible.
 */
const NOTHING_TO_GRADE_UNSTATED =
  'this gate reported nothing to grade and did not say what it looked for'

/**
 * Which section a row prints under.
 *
 * Takes the whole entry rather than a status, because the section has to be
 * the one the run will act on and that is decided by `status` × `checkClass`,
 * not by `status` alone. A semantic `fail` is acknowledgeable — the run offers
 * Sign — so printing it under "the proposal is wrong, do not sign" told the
 * signer the opposite of what happened next.
 *
 * @param entry - The result, its definition, and why it had nothing to do.
 * @returns The bucket whose heading matches the run's own decision.
 */
export const bucketOf = (entry: IBucketedResult): CheckBucket => {
  const { result } = entry
  if (entry.notApplicable) return 'n/a'
  if (NOTHING_TO_GRADE_STATUSES.has(result.status)) return 'n/a'
  if (result.status === 'pass') return 'passed'
  if (result.status === 'fail' || result.status === 'needs-ack')
    return isAcknowledgeable(entry.definition, result) ? 'ack' : 'wrong'
  // Anything this view does not recognise is an unmade reading, never a pass:
  // a status it cannot name is a status it cannot vouch for.
  return 'unchecked'
}

const rule = (char: string): string => char.repeat(VIEW_WIDTH)

/**
 * What the gate *found*, as the word its manifest row carries.
 *
 * Keyed on the status rather than on the bucket, because the row states two
 * different things and the bucket only answers one of them. The glyph and the
 * last column say what the signer can do about it — the run's own decision,
 * `status` × `checkClass`. This says what was observed. A semantic mismatch is
 * acknowledgeable *and* the proposal really does disagree, so it reads `WRONG`
 * under a glyph that offers a way through; collapsing both onto the bucket
 * printed `ASKS YOU` over a payload that reverts.
 *
 * A word rather than a glyph alone, because this output is read piped to a file
 * and pasted into Slack at least as often as it is read in a terminal, and
 * colour is the first thing both of those lose.
 */
const MANIFEST_WORD: ReadonlyMap<string, string> = new Map([
  ['pass', 'ok'],
  ['fail', 'WRONG'],
  ['needs-ack', 'ASKS YOU'],
  ['not-applicable', 'n/a'],
])

/** A status this view cannot name is an unmade reading, never a pass. */
const MANIFEST_UNCHECKED = 'UNCHECKED'

/**
 * What a gate on the roster that produced no result reads as.
 *
 * Not a bucket: every `CheckBucket` describes a result, and the whole point of
 * this row is that there is none. `summariseLedger` counts a registered check
 * with no row as missing and blocks on it, so the word has to be as loud as the
 * ones that do have a result behind them.
 */
const SILENT = { glyph: '!', word: 'NO RESULT', colour: YELLOW } as const

/**
 * Glyphs that occupy two terminal columns rather than one.
 *
 * The three verdicts a signer acts on are emoji-presentation, so that the mark
 * carries the verdict at a glance rather than the word beside it having to.
 * The manifest is the only place in this view where a glyph sits in an aligned
 * column, so the width is paid here rather than by giving the table its own
 * glyph vocabulary: the same gate showing one mark in the table and a different
 * one in the section below it is a worse defect than a column that has to
 * measure its own glyphs.
 */
const WIDE_GLYPHS: ReadonlySet<string> = new Set(['⛔', '⚠️', '✅'])

/** Columns the manifest's glyph cell occupies, widest glyph plus a separator. */
const GLYPH_CELL_WIDTH = 3

/**
 * A glyph padded to a fixed cell, so every row's letter starts level.
 *
 * The separating column is inside the cell rather than written after it: an
 * emoji already fills two columns, so a cell sized to the glyph alone puts the
 * gate letter hard against the mark on exactly the rows a signer reads first.
 */
const glyphCell = (glyph: string): string =>
  `${glyph}${' '.repeat(GLYPH_CELL_WIDTH - (WIDE_GLYPHS.has(glyph) ? 2 : 1))}`

/**
 * Columns the manifest spends on everything that is not the gate's title.
 *
 * Derived rather than written down so the dot leader cannot drift out of the
 * view when a column is widened: two of margin, the glyph cell, a space, the
 * letter, two spaces, then the verdict word and the disposition with a space
 * each side.
 */
const MANIFEST_WORD_WIDTH = 10
const MANIFEST_BLOCKS_WIDTH = 6
/** The letter's cell, sized to its own header plus a separating column. */
const MANIFEST_GATE_WIDTH = 5
const MANIFEST_FIXED =
  2 +
  GLYPH_CELL_WIDTH +
  MANIFEST_GATE_WIDTH +
  1 +
  MANIFEST_WORD_WIDTH +
  1 +
  MANIFEST_BLOCKS_WIDTH +
  2

/**
 * What each column holds, over the columns themselves.
 *
 * The glyph gets none: it is the same mark the bucket headings below already
 * name, and a word over it would be the only header describing something the
 * reader can already read.
 */
const MANIFEST_HEADERS = {
  gate: 'GATE',
  title: 'WHAT IT ASSERTS',
  word: 'RESULT',
  blocks: 'ACTION',
  link: 'GATE DOCUMENTATION',
} as const

/**
 * Columns a gate title may occupy before the dot leader collapses.
 *
 * Exported so the titles can be pinned against the column they are printed in
 * rather than against a number written down twice: the titles state their
 * assertion, so they sit close enough to the limit that a reworded one can
 * cross it. Takes the link column's width because the write-up links take
 * their columns from this one, so the roster only fits if it fits beside them.
 *
 * @param linkWidth - Columns the write-up column occupies, 0 when absent.
 * @returns The columns left for a title.
 */
export const manifestTitleWidth = (linkWidth: number): number =>
  Math.max(0, VIEW_WIDTH - MANIFEST_FIXED - (linkWidth ? linkWidth + 1 : 0))

export interface IGateManifestInput {
  /** Every result this run produced, in any order. */
  entries: readonly IBucketedResult[]
  /**
   * Every gate the view can name, in the order the manifest prints them.
   *
   * Passed in rather than built here, so the roster the signer counts is the
   * same constant the run registers its checks from and the two cannot drift.
   */
  roster: readonly ICheckDefinition[]
  /**
   * The gates that owe this run a result.
   *
   * A subset of `roster`, because a gate can have a letter and a subject
   * without having a ledger denominator. Counting such a gate among the ones
   * that must report would make every run block on a check that is working.
   */
  mustReport: ReadonlySet<string>
  /**
   * Where each gate is written up, by `checkId`.
   *
   * Keyed off the roster rather than off the results, so the gate that reported
   * nothing — the row this table exists to make visible — still carries the
   * link a signer needs in order to find out what it was supposed to do.
   *
   * Passed in rather than imported: this module knows how the zones are drawn
   * and nothing about which checks exist.
   */
  docUrls?: ReadonlyMap<string, string>
  /**
   * Checks that print below the roster and decide nothing, titled as they title
   * themselves.
   *
   * Not on `roster`, because a letter is what the view calls a gate and these
   * may never pass: their evidence is the deployment record, which
   * `check-ledger.ts` lets report but never decide. Listed all the same — a
   * check the manifest omits and the page then shows is the same hole the
   * roster exists to close, and the one a signer resolves by assuming the
   * block below belongs to whichever gate it followed.
   */
  reportOnly?: readonly { title: string; note: string }[]
}

/**
 * Zone 2's opening table: every gate the run can name, one line each, always.
 *
 * The sections below answer "what should I read first". This answers "what was
 * there to check at all", which nothing in the view answered before: it renders
 * the *roster* and joins the results onto it, so a gate that reported nothing
 * occupies a line saying `NO RESULT` instead of silently not being on the page.
 * That is not hypothetical — `storage-authority` produced no row on any of the
 * eleven rehearsal proposals, and no screen said so.
 *
 * @param input - The results, the roster, and which gates owe a result.
 * @returns The table and its tally, one line per gate on the roster.
 */
export const renderGateManifest = (input: IGateManifestInput): string[] => {
  const byCheckId = new Map(
    input.entries.map((entry) => [entry.result.checkId, entry])
  )
  // Sized to the longest link actually on the roster, not to a written-down
  // number: the column is absent entirely until the write-ups exist, and a
  // reserved width would take those columns from the dot leader for nothing.
  const linkWidth = Math.max(
    0,
    ...input.roster.map(
      (definition) => input.docUrls?.get(definition.checkId)?.length ?? 0
    ),
    input.docUrls?.size ? MANIFEST_HEADERS.link.length : 0
  )
  const titleWidth = manifestTitleWidth(linkWidth)
  const out: string[] = []
  let reported = 0
  let silent = 0

  // A link column only aligns if what precedes it is padded rather than
  // trimmed, so a row's trailing whitespace is cut only when nothing follows.
  const endRow = (row: string, link: string): string =>
    link ? `${row} ${BLUE}${link}${RESET}` : row.trimEnd()

  out.push(
    `${DIM}${' '.repeat(2 + GLYPH_CELL_WIDTH)}` +
      `${MANIFEST_HEADERS.gate.padEnd(MANIFEST_GATE_WIDTH)}` +
      `${MANIFEST_HEADERS.title.padEnd(titleWidth)} ` +
      `${MANIFEST_HEADERS.word.padEnd(MANIFEST_WORD_WIDTH)} ` +
      `${
        linkWidth
          ? `${MANIFEST_HEADERS.blocks.padEnd(MANIFEST_BLOCKS_WIDTH)} ` +
            MANIFEST_HEADERS.link
          : MANIFEST_HEADERS.blocks
      }${RESET}`.trimEnd()
  )

  for (const definition of input.roster) {
    const entry = byCheckId.get(definition.checkId)
    const owed = input.mustReport.has(definition.checkId)

    const [glyph, colour, word] = ((): [string, string, string] => {
      if (entry) {
        const bucket = bucketOf(entry)
        const style = BUCKET_STYLE.get(bucket)
        return [
          style?.glyph ?? '?',
          style?.colour ?? '',
          entry.notApplicable
            ? 'n/a'
            : MANIFEST_WORD.get(entry.result.status) ?? MANIFEST_UNCHECKED,
        ]
      }
      // A gate with no result: blocking when it owed one, and merely absent
      // when it never did.
      return owed
        ? [SILENT.glyph, SILENT.colour, SILENT.word]
        : ['·', DIM, 'not run']
    })()

    if (owed) {
      if (entry) reported += 1
      else silent += 1
    }

    // Blocking is a property of the run's decision, not of the glyph: a gate
    // that owed a result and gave none blocks even though it has no status.
    const blocks = entry
      ? bucketOf(entry) === 'wrong' || bucketOf(entry) === 'unchecked'
      : owed
    const yours = entry ? bucketOf(entry) === 'ack' : false

    const dots = '.'.repeat(
      Math.max(2, titleWidth - definition.title.length - 1)
    )
    const disposition = blocks
      ? `${RED}BLOCKS${RESET}`
      : yours
      ? `${YELLOW}REVIEW${RESET}`
      : ''
    // Trimmed over the whole row, not the last fragment: a gate with no
    // disposition otherwise keeps the separating space, and half the table
    // ships trailing whitespace into whatever the run is piped into.
    out.push(
      endRow(
        `  ${colour}${glyphCell(glyph)}${RESET}${BOLD}${
          definition.gate
        }${RESET}${' '.repeat(
          Math.max(0, MANIFEST_GATE_WIDTH - definition.gate.length)
        )}` +
          `${definition.title} ${DIM}${dots}${RESET} ` +
          // Padded outside the colour: inside it the row ends in a reset code
          // rather than a space, so `trimEnd` cannot see the padding and every
          // row without a disposition ships trailing whitespace.
          `${colour}${word}${RESET}${' '.repeat(
            Math.max(0, MANIFEST_WORD_WIDTH - word.length)
          )} ` +
          `${disposition}${' '.repeat(
            Math.max(0, MANIFEST_BLOCKS_WIDTH - visibleWidth(disposition))
          )}`,
        input.docUrls?.get(definition.checkId) ?? ''
      )
    )
  }

  // A result the roster cannot name still has to reach the screen. It would
  // otherwise be counted by the ledger and invisible on the page, which is the
  // same hole the roster exists to close, one level along.
  for (const entry of input.entries)
    if (!input.roster.some((d) => d.checkId === entry.result.checkId))
      out.push(
        `  ${RED}${glyphCell('?')}${RESET}${BOLD}?${RESET}  ${
          entry.result.checkId
        } ${RED}— this result names no gate on the roster${RESET}`
      )

  // Below the gates and dimmed, because the distinction the signer has to keep
  // is which rows can stop a signature, and a report-only row rendered in the
  // gate column would have to be read to be told apart from one that can.
  for (const check of input.reportOnly ?? [])
    out.push(
      `  ${DIM}${glyphCell('·')}${' '.repeat(MANIFEST_GATE_WIDTH)}${
        check.title
      } — ${check.note}${RESET}`
    )

  out.push('')
  out.push(
    `  ${input.roster.length} gates · ${input.mustReport.size} owe a result · ` +
      `${reported} reported${
        silent ? ` · ${YELLOW}${silent} silent${RESET}` : ''
      }${
        input.reportOnly?.length
          ? ` ${DIM}· ${input.reportOnly.length} report-only${RESET}`
          : ''
      }`
  )
  return out
}

/**
 * A zone heading.
 *
 * @param index - 1, 2 or 3; printed so the three read as one sequence.
 * @param title - What the zone is for, in the second person.
 * @param right - Optional summary pinned to the right of the same line.
 * @returns The heading block, blank-separated from whatever preceded it.
 */
export const zoneHeading = (
  index: number,
  title: string,
  right = ''
): string[] => {
  const left = ` ${index} · ${title}`
  const gap = Math.max(1, VIEW_WIDTH - left.length - right.length)
  return [
    '',
    '',
    `${BOLD}${rule('═')}${RESET}`,
    `${BOLD}${left}${' '.repeat(gap)}${right}${RESET}`,
    `${BOLD}${rule('═')}${RESET}`,
  ]
}

/**
 * What separates one proposal from the next in a run.
 *
 * A run walks several proposals and each one ends wherever the signer's choice
 * left it — on the action prompt, or on the device checklist below it — so
 * without a break the next proposal's zone 1 reads as more of the previous
 * one's, and the field a signer is comparing against an out-of-band message is
 * then the wrong proposal's.
 */
export const PROPOSAL_SEPARATOR: readonly string[] = (() => {
  const banner = ' END OF PROPOSAL '
  const wings = Math.max(3, Math.floor((VIEW_WIDTH - banner.length) / 2))
  return [
    '',
    '',
    `${DIM}${'x'.repeat(VIEW_WIDTH)}${RESET}`,
    `${BOLD}${'<'.repeat(wings)}${banner}${'>'.repeat(wings)}${RESET}`,
    `${DIM}${'x'.repeat(VIEW_WIDTH)}${RESET}`,
    '',
    '',
  ]
})()

export interface IViewField {
  label: string
  value: string
  /** Drawn under the value, indented, for a field that needs one. */
  note?: string
}

/**
 * Zone 1 — the transaction, as fields.
 *
 * @param fields - Label/value rows, already formatted and coloured.
 * @returns The rows, labels aligned.
 */
export const renderFields = (fields: readonly IViewField[]): string[] => {
  const width = Math.max(0, ...fields.map((f) => f.label.length))
  const out: string[] = []
  for (const field of fields) {
    out.push(`  ${field.label.padEnd(width)}  ${field.value}`)
    if (field.note)
      out.push(`  ${' '.repeat(width)}  ${DIM}${field.note}${RESET}`)
  }
  return out
}

/**
 * The longest word a signer could still read off the screen and compare: a
 * bytes32 with its `0x`.
 *
 * Anything longer is a payload rather than a value. A viem revert dump carries
 * the entire calldata it called with, and zone 1 already prints that calldata
 * in full — printed again here it runs off every terminal and buries the revert
 * reason, which is the one line on the row worth reading.
 */
const LONGEST_READABLE_WORD = 66

const elideUnreadable = (word: string): string =>
  word.length <= LONGEST_READABLE_WORD
    ? word
    : `${word.slice(0, 24)}…(${word.length} chars)`

/** An SGR sequence occupies no columns, so width is measured without them. */
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu')

const visibleWidth = (text: string): number => text.replace(SGR, '').length

/**
 * A pre-formatted note, folded into the view without breaking its colour.
 *
 * Notes arrive built elsewhere — the executability panel and the target-state
 * lines — already indented and already carrying their own glyphs and SGR
 * sequences. They were pushed through untouched, which is how a 188-column line
 * reached a 76-column view: a single unwrapped note takes every row under it out
 * of alignment, which is the whole reason the rest of this module wraps.
 *
 * Width is measured without the escapes, because an escape costs no columns and
 * counting it would fold a line that fits. Each word is re-emitted with the
 * codes that were active when it was read and closed again after it, rather than
 * a colour span being carried across a line break: a span left open at a break
 * bleeds into the indent of the next line, and one closed at a break silently
 * loses its colour. Per-word emission is more bytes on the wire and cannot get
 * either wrong.
 *
 * Continuations hang two columns past the note's own indent, so a folded note
 * still reads as one item rather than as two.
 *
 * @param line - One note line, as its producer formatted it.
 * @returns The line, or the folded lines that replace it.
 */
const wrapNote = (line: string): string[] => {
  if (visibleWidth(line) <= VIEW_WIDTH) return [line]

  const plain = line.replace(SGR, '')
  const indent = /^ */u.exec(plain)?.[0] ?? ''
  const hang = `${indent}  `

  const tokens: { word: string; codes: string }[] = []
  let codes = ''
  let word = ''
  let index = 0

  while (index < line.length) {
    SGR.lastIndex = index
    const match = SGR.exec(line)

    if (match && match.index === index) {
      if (word) {
        tokens.push({ word, codes })
        word = ''
      }
      codes = match[0] === RESET ? '' : `${codes}${match[0]}`
      index += match[0].length
      continue
    }

    const char = line[index] as string
    if (/\s/u.test(char)) {
      if (word) {
        tokens.push({ word, codes })
        word = ''
      }
    } else word += char
    index += 1
  }
  if (word) tokens.push({ word, codes })

  const out: string[] = []
  let current = ''
  let width = 0
  let prefix = indent

  const flush = (): void => {
    if (current) out.push(`${prefix}${current}`)
    current = ''
    width = 0
    prefix = hang
  }

  for (const token of tokens) {
    const need = width === 0 ? token.word.length : token.word.length + 1
    // A word longer than the line still goes on its own: breaking it would
    // split an address or a selector into two unsearchable halves.
    if (width > 0 && prefix.length + width + need > VIEW_WIDTH) flush()
    current += `${width === 0 ? '' : ' '}${token.codes}${token.word}${
      token.codes ? RESET : ''
    }`
    width += need
  }
  flush()

  return out.length > 0 ? out : [line]
}

/**
 * One `expected`/`observed`/detail value, as lines that stay inside the view.
 *
 * These come from whatever check produced the row, and a simulator's revert
 * message arrives as a multi-line dump of its own. Printed raw it breaks the
 * column, runs off the terminal, and takes the rows under it out of alignment —
 * so a signer skimming for the red row finds a wall instead. Folded to single
 * spaces and wrapped under a hanging indent, never truncated: the revert reason
 * is the most useful thing on a failing row.
 *
 * @param label - The leading label, printed once on the first line.
 * @param value - The value, with any internal line breaks.
 * @param colour - Applied to the value on every line, never to the label.
 * @param indent - The column the label starts in; values hang under it.
 * @returns Lines, already indented for the check block.
 */
const wrapValue = (
  label: string,
  value: string,
  colour = '',
  indent = '        '
): string[] => {
  const hang = `${indent}${' '.repeat(label.length)}`
  const paint = (text: string): string =>
    colour ? `${colour}${text}${RESET}` : text

  const words = value
    .split(/\s+/u)
    .filter(Boolean)
    .map((raw) => elideUnreadable(raw))

  const fold = (budget: number): string[] => {
    const out: string[] = []
    let line = ''
    for (const word of words) {
      const next = line ? `${line} ${word}` : word
      // A single word longer than the budget still goes on its own line:
      // breaking it would split an address or a hash into two unsearchable
      // halves.
      if (next.length > budget && line) {
        out.push(line)
        line = word
      } else line = next
    }
    if (line) out.push(line)
    return out
  }

  const hangingBudget = Math.max(20, VIEW_WIDTH - hang.length)

  // A word that cannot fit beside its label takes the label's line back.
  //
  // A bytes32 is 66 characters and `LONGEST_READABLE_WORD` is 66, so it is
  // never elided — correctly, since comparing it is the whole job. Under an
  // eight-column indent and a ten-column label the budget is 58, so it hung off
  // the view at 84 columns. Dropping the label to its own line buys back
  // exactly the label's width, which is what makes a hash fit, and it puts the
  // two values in the same column so the eye can run down them.
  if (words.some((word) => word.length > hangingBudget)) {
    const fullBudget = Math.max(20, VIEW_WIDTH - indent.length)

    return [
      `${indent}${label.trimEnd()}`,
      ...fold(fullBudget).map((text) => `${indent}${paint(text)}`),
    ]
  }

  const out = fold(hangingBudget)
  if (out.length === 0) return [`${indent}${label}`]

  return out.map((text, position) =>
    position === 0 ? `${indent}${label}${paint(text)}` : `${hang}${paint(text)}`
  )
}

/**
 * Two values a signer has to compare character by character, stacked.
 *
 * A bytes32 is 66 characters and the view is 76 wide, so the pair cannot sit
 * under a labelled column at any useful indent — and wrapping is the one thing
 * that must not happen to a string about to be checked against a device screen.
 * So the values are pulled back to the margin, printed adjacent because
 * comparing them is the task, with the labels pointing inwards at the pair and
 * a caret row doing the comparison the signer was otherwise going to do by eye.
 *
 * The tamper this exists for changes one character of a 66-character hash, and
 * the old arrangement printed the two 84-column strings four rows apart.
 *
 * @param expected - What the check required.
 * @param actual - What it observed.
 * @param colour - The mismatch colour, applied to the observed value.
 * @param indent - The column the pair is printed at.
 * @returns The stacked pair, or nothing when this shape does not apply.
 */
const hashPair = (
  expected: string,
  actual: string,
  colour: string,
  indent = '        '
): string[] => {
  const budget = Math.max(20, VIEW_WIDTH - indent.length)
  const single = (value: string): boolean =>
    value.trim().length > 0 && !/\s/u.test(value.trim())

  // Only a pair of unbreakable tokens of one length: a caret row under values
  // of different lengths points at a column that means nothing, and a value
  // with spaces in it is prose, which reads better under its label.
  if (!single(expected) || !single(actual)) return []
  const left = expected.trim()
  const right = actual.trim()
  if (left.length !== right.length) return []
  if (left.length > budget) return []
  if (left === right) return []

  let carets = ''
  for (let index = 0; index < left.length; index += 1)
    carets += left[index] === right[index] ? ' ' : '^'

  return [
    `${indent}${DIM}expected ↓${RESET}`,
    `${indent}${left}`,
    `${indent}${colour ? `${colour}${right}${RESET}` : right}`,
    `${indent}${RED}${carets.replace(/\s+$/u, '')}${RESET}`,
    `${indent}${DIM}observed ↑  carets mark every character that differs${RESET}`,
  ]
}

/**
 * The labels a check prints its values under, and the column they leave for the
 * values themselves.
 *
 * Derived from the widest label rather than written into each one, because the
 * only reason expected and observed are printed one above the other is that a
 * signer compares them by reading down a single column — a label added here
 * with a different width would silently step that column.
 */
const VALUE_LABELS = ['expected', 'observed'] as const
const VALUE_LABEL_GAP = 2
const valueLabel = (label: string): string =>
  label.padEnd(
    Math.max(...VALUE_LABELS.map((one) => one.length)) + VALUE_LABEL_GAP
  )

/**
 * The colour the observed value carries when it disagrees with the expected one.
 *
 * Only where the disagreement is the proposal's. An unchecked row's `actual` is
 * why nothing could be read, so a mismatch colour there tells the signer the
 * transaction is wrong when their environment is. Red keeps the one meaning it
 * has everywhere else in this view — do not sign — and a mismatch that can be
 * acknowledged therefore takes its own bucket's colour rather than borrowing it.
 */
const MISMATCH_COLOUR: ReadonlyMap<CheckBucket, string> = new Map([
  ['wrong', RED],
  ['ack', YELLOW],
])

/**
 * Values print folded to single spaces, so two that differ only in whitespace
 * reach the signer as the same text. Marking one of them red sends a signer
 * looking for a difference that is not on the screen.
 *
 * @param bucket - The bucket the row prints under.
 * @param result - The result whose two values are being printed.
 * @returns The colour for the observed value, or nothing.
 */
const mismatchColour = (bucket: CheckBucket, result: ICheckResult): string => {
  const fold = (value: string): string => value.replace(/\s+/gu, ' ').trim()
  if (fold(result.expected) === fold(result.actual)) return ''
  return MISMATCH_COLOUR.get(bucket) ?? ''
}

export interface IBucketedResult {
  result: ICheckResult
  definition: ICheckDefinition | undefined
  /** Why the proposal gave this check nothing to do, when it did not. */
  notApplicable?: string
  /**
   * Lines printed under this check, already indented by whoever produced them.
   *
   * Where a check states what it compared against — the ref a target state was
   * read from, say. That provenance belongs to the check, not to the verdict,
   * so it survives the check landing in the collapsed PASSED run.
   */
  notes?: readonly string[]
}

/**
 * Zone 2 — every check, grouped by what it means for the signer.
 *
 * Passed checks collapse to one line: they have to be visibly present, so that
 * a missing one is noticeable, and they must not crowd out the rows that ask
 * for something. Every other bucket prints a row per check.
 *
 * @param results - Each check's latest result, with its definition for a title.
 * @returns The grouped block, empty buckets omitted.
 */
export const renderCheckGroups = (
  results: readonly IBucketedResult[]
): string[] => {
  const grouped = new Map<CheckBucket, IBucketedResult[]>()
  for (const entry of results) {
    const bucket = bucketOf(entry)
    const list = grouped.get(bucket)
    if (list) list.push(entry)
    else grouped.set(bucket, [entry])
  }

  const out: string[] = []
  for (const bucket of BUCKET_ORDER) {
    const entries = grouped.get(bucket)
    if (!entries?.length) continue
    // A passed gate asks nothing of the signer, and the manifest above states
    // its verdict and its write-up on one line. Everything this section could
    // add is evidence for a verdict nobody is being asked to weigh — including
    // the simulation panel, which is worth its twelve lines only on the run
    // where a call does not execute.
    if (bucket === 'passed') continue
    const style = BUCKET_STYLE.get(bucket)
    if (!style) continue

    out.push('')
    out.push(`  ${style.colour}${BOLD}${style.heading}${RESET}`)

    let first = true
    // The write-up link is not repeated here. Every gate on the roster carries
    // it in the manifest above, so a second copy per row is the same URL twice
    // on one screen, and a line the eye has to skip on every row that asks for
    // something.
    for (const { result, definition, notApplicable, notes } of entries) {
      // Between gates only: a leading blank would double the one this bucket's
      // heading already printed.
      if (!first) out.push('')
      first = false
      const title = definition ? gateLabel(definition) : result.checkId
      // A gate with nothing to grade puts the reason in `actual`.
      const standDownReason =
        notApplicable ??
        (bucket === 'n/a'
          ? result.actual.trim() || NOTHING_TO_GRADE_UNSTATED
          : undefined)
      out.push(
        `    ${style.colour}${style.glyph}${RESET} ${BOLD}${title}${RESET}`
      )
      // No `expected`/`observed` pair: the gate's `expected` is boilerplate no
      // proposal can fail, and a pair invites a comparison that means nothing.
      // The title line above is the same one every other row prints, so a
      // signer skimming the left edge reads one shape rather than two.
      if (standDownReason) {
        out.push(...wrapValue('', standDownReason, DIM))
        out.push(...(notes ?? []).flatMap(wrapNote))
        continue
      }
      // The pair form when both values are one unbreakable token of the same
      // length — a hash against a hash. Everything else reads better under its
      // label.
      const pair = hashPair(
        result.expected,
        result.actual,
        mismatchColour(bucket, result)
      )
      if (pair.length) out.push(...pair)
      else {
        out.push(...wrapValue(valueLabel('expected'), result.expected))
        out.push(
          ...wrapValue(
            valueLabel('observed'),
            result.actual,
            mismatchColour(bucket, result)
          )
        )
      }
      if (result.detail)
        out.push(
          ...wrapValue('→ ', result.detail).map(
            (line) => `${BLUE}${line}${RESET}`
          )
        )
      out.push(...(notes ?? []).flatMap(wrapNote))
    }
  }
  return out
}

export interface ITodo {
  text: string
  /** Indented continuation lines under the item. */
  lines?: readonly string[]
}

/** Pinned beside zone 3's heading while the checklist is still withheld. */
export const TODOS_DEFERRED_SUMMARY = 'after you choose to sign'

/**
 * Zone 3's placeholder, printed in its slot on the decision screen.
 *
 * The checklist itself is withheld until the signer picks an action that ends
 * on a device, because a run that stops at `Do Nothing` never needed it and the
 * panel is thirty lines of device art between zone 2 and the prompt the
 * decision is made at. The heading still prints: a zone that silently is not
 * there is the same failure as a gate that reports nothing and is simply absent
 * from the page, and a signer who has read this screen before would otherwise
 * be looking for a hash that never appears.
 *
 * @returns The placeholder body, without the heading.
 */
export const renderDeferredTodos = (): string[] => [
  '',
  `  ${DIM}The hash to compare and the device screens print once you choose an${RESET}`,
  `  ${DIM}action that signs — they are the last thing before the device, not${RESET}`,
  `  ${DIM}input to the decision you are making here.${RESET}`,
]

/**
 * Zone 3 — what the machine cannot do for the signer.
 *
 * Rendered as unticked boxes rather than prose: these are steps, they are the
 * last thing before an irreversible action, and a paragraph reads as background.
 *
 * @param todos - The steps, in the order they are performed.
 * @returns The checklist block.
 */
export const renderTodos = (todos: readonly ITodo[]): string[] => {
  const out: string[] = []
  for (const todo of todos) {
    out.push('')
    out.push(`  ${BOLD}☐ ${todo.text}${RESET}`)
    for (const line of todo.lines ?? []) out.push(`      ${line}`)
  }
  return out
}

/**
 * The one-line summary pinned beside zone 2's heading.
 *
 * Counts what is wrong and what went unchecked separately, because collapsing
 * them into one "failed" number is the same conflation the buckets exist to
 * undo.
 *
 * @param results - The same results zone 2 renders.
 * @returns A summary such as "3 wrong · 2 unchecked · 3 passed".
 */
/**
 * What this proposal's gates add up to, in one sentence, before the prompt.
 *
 * The buckets above already say it row by row, but a signer who has scrolled
 * past twelve rows is deciding from whatever is on screen when the prompt
 * appears — so the conclusion is restated where the decision is actually made,
 * naming the gates it rests on.
 *
 * @param results - The proposal's bucketed rows.
 * @returns Lines, already coloured.
 */
export const renderProposalOutcome = (
  results: readonly IBucketedResult[]
): string[] => {
  const inBucket = (want: CheckBucket): string[] =>
    results
      .filter((entry) => bucketOf(entry) === want)
      .map((entry) =>
        entry.definition
          ? `Gate ${entry.definition.gate}`
          : entry.result.checkId
      )

  const name = (gates: readonly string[]): string => gates.join(', ')
  const wrong = inBucket('wrong')
  const unchecked = inBucket('unchecked')
  const ack = inBucket('ack')

  const say = (colour: string, text: string): string[] => [
    '',
    ...wrapValue('', text, `${BOLD}${colour}`, '  '),
  ]

  if (wrong.length)
    return say(
      RED,
      `This proposal cannot be signed: ${
        wrong.length
      } mandatory gate(s) disagreed — ${name(
        wrong
      )}. An integrity gate has no acknowledgement path, so review and fix the proposal before proceeding.`
    )

  if (unchecked.length)
    return say(
      YELLOW,
      `This proposal cannot be signed yet: ${
        unchecked.length
      } gate(s) could not be checked — ${name(
        unchecked
      )}. That is your environment rather than the proposal; fix it and run again.`
    )

  if (ack.length)
    return say(
      YELLOW,
      `Every mandatory gate passed. ${
        ack.length
      } gate(s) reached a weaker answer than a pass — ${name(
        ack
      )}. Signing means you accept what each of them says it could not establish.`
    )

  return say(GREEN, 'Every gate passed. Nothing here blocks the signature.')
}

export const checkSummary = (results: readonly IBucketedResult[]): string => {
  const counts = new Map<CheckBucket, number>()
  for (const entry of results) {
    const bucket = bucketOf(entry)
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1)
  }
  const parts: string[] = []
  const label: Record<CheckBucket, string> = {
    wrong: 'wrong',
    unchecked: 'unchecked',
    ack: 'to acknowledge',
    passed: 'passed',
    'n/a': 'n/a',
  }
  for (const bucket of BUCKET_ORDER) {
    const n = counts.get(bucket)
    if (n) parts.push(`${n} ${label[bucket]}`)
  }
  return parts.join(' · ')
}
