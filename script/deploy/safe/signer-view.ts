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
import { gateLabel } from './check-ledger'

const ESC = String.fromCharCode(27)
const RESET = `${ESC}[0m`
const BOLD = `${ESC}[1m`
const DIM = `${ESC}[2m`
const RED = `${ESC}[31m`
const GREEN = `${ESC}[32m`
const YELLOW = `${ESC}[33m`
const BLUE = `${ESC}[36m`

/** Terminal columns the zones are drawn to. */
export const VIEW_WIDTH = 76

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
      glyph: '⚠',
      colour: YELLOW,
    },
  ],
  ['passed', { heading: 'PASSED', glyph: '✓', colour: GREEN }],
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
 * Which bucket a result belongs in.
 *
 * `notApplicable` is a separate argument rather than a status, because there is
 * no such status: whether a check has anything to say is a property of the
 * proposal (no diamondCut, so no bytecode to vouch for), while `status` records
 * how the check that did run came out. Folding the two loses the distinction
 * between "nothing to check" and "could not check", which are opposite news.
 *
 * @param status - The recorded status.
 * @param notApplicable - True when the proposal gave this check nothing to do.
 * @returns The bucket the row prints under.
 */
export const bucketOf = (
  status: string,
  notApplicable = false
): CheckBucket => {
  if (notApplicable) return 'n/a'
  if (status === 'pass') return 'passed'
  if (status === 'fail') return 'wrong'
  if (status === 'needs-ack') return 'ack'
  // Anything this view does not recognise is an unmade reading, never a pass:
  // a status it cannot name is a status it cannot vouch for.
  return 'unchecked'
}

const rule = (char: string): string => char.repeat(VIEW_WIDTH)

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
 * A run walks several proposals and each one ends on a checklist, so without a
 * break the next proposal's zone 1 reads as more of the previous one's zone 3 —
 * and the field a signer is comparing against an out-of-band message is then the
 * wrong proposal's.
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
  const budget = Math.max(20, VIEW_WIDTH - hang.length)
  const out: string[] = []
  let line = ''

  for (const raw of value.split(/\s+/u).filter(Boolean)) {
    const word = elideUnreadable(raw)
    const next = line ? `${line} ${word}` : word
    // A single word longer than the budget still goes on its own line: breaking
    // it would split an address or a hash into two unsearchable halves.
    if (next.length > budget && line) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)
  if (out.length === 0) return [`${indent}${label}`]

  return out.map((text, position) =>
    position === 0 ? `${indent}${label}${paint(text)}` : `${hang}${paint(text)}`
  )
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
   * Where this check is written up, when there is somewhere to point at.
   *
   * A signer reading "the target is an address this checkout can name" at two
   * in the morning needs somewhere to go that is not the source. Absent until
   * the write-ups exist; a row without one prints exactly as it did before.
   */
  docUrl?: string
  /**
   * The subject alone, for the collapsed PASSED run.
   *
   * A passed check asks nothing of the signer, so the sentence stating what it
   * asserted is worth less there than getting the whole run onto two lines that
   * are taken in at once. Every other bucket keeps the full title, where the
   * assertion is the point.
   */
  shortTitle?: string
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
    const bucket = bucketOf(entry.result.status, Boolean(entry.notApplicable))
    const list = grouped.get(bucket)
    if (list) list.push(entry)
    else grouped.set(bucket, [entry])
  }

  const out: string[] = []
  for (const bucket of BUCKET_ORDER) {
    const entries = grouped.get(bucket)
    if (!entries?.length) continue
    const style = BUCKET_STYLE.get(bucket)
    if (!style) continue

    out.push('')
    out.push(`  ${style.colour}${BOLD}${style.heading}${RESET}`)

    if (bucket === 'passed') {
      // One line per gate, not a run: a signer checking that a particular gate
      // ran has to find it, and a name inside a wrapped list of names is the
      // one arrangement that cannot be scanned down.
      for (const entry of entries) {
        const title = entry.definition
          ? gateLabel(entry.definition)
          : entry.result.checkId
        out.push(
          `    ${style.colour}${style.glyph}${RESET} ${title}${
            entry.docUrl ? ` ${BLUE}${entry.docUrl}${RESET}` : ''
          }`
        )
        out.push(...(entry.notes ?? []))
      }
      continue
    }

    let first = true
    for (const {
      result,
      definition,
      notApplicable,
      docUrl,
      notes,
    } of entries) {
      // Between gates only: a leading blank would double the one this bucket's
      // heading already printed.
      if (!first) out.push('')
      first = false
      const title = definition ? gateLabel(definition) : result.checkId
      if (notApplicable) {
        out.push(
          ...wrapValue(
            `${style.glyph} `,
            `${title} — ${notApplicable}`,
            '',
            '    '
          ).map((line) => `${style.colour}${line}${RESET}`)
        )
        out.push(...(notes ?? []))
        continue
      }
      out.push(
        `    ${style.colour}${style.glyph}${RESET} ${BOLD}${title}${RESET}${
          docUrl ? ` ${BLUE}${docUrl}${RESET}` : ''
        }`
      )
      out.push(...wrapValue(valueLabel('expected'), result.expected))
      out.push(
        ...wrapValue(
          valueLabel('observed'),
          result.actual,
          mismatchColour(bucket, result)
        )
      )
      if (result.detail)
        out.push(
          ...wrapValue('→ ', result.detail).map(
            (line) => `${BLUE}${line}${RESET}`
          )
        )
      out.push(...(notes ?? []))
    }
  }
  return out
}

export interface ITodo {
  text: string
  /** Indented continuation lines under the item. */
  lines?: readonly string[]
}

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
 * past twelve rows and a device panel is deciding from whatever is on screen
 * when the prompt appears — so the conclusion is restated where the decision is
 * actually made, naming the gates it rests on.
 *
 * @param results - The proposal's bucketed rows.
 * @returns Lines, already coloured.
 */
export const renderProposalOutcome = (
  results: readonly IBucketedResult[]
): string[] => {
  const inBucket = (want: CheckBucket): string[] =>
    results
      .filter(
        (entry) =>
          bucketOf(entry.result.status, Boolean(entry.notApplicable)) === want
      )
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
    const bucket = bucketOf(entry.result.status, Boolean(entry.notApplicable))
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
