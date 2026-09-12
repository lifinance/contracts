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
  const label = ' end of proposal '
  const bar = Math.max(0, VIEW_WIDTH - label.length)
  const left = Math.floor(bar / 2)
  return [
    '',
    '',
    `${BOLD}${'━'.repeat(left)}${label}${'━'.repeat(bar - left)}${RESET}`,
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

export interface IBucketedResult {
  result: ICheckResult
  definition: ICheckDefinition | undefined
  /** Why the proposal gave this check nothing to do, when it did not. */
  notApplicable?: string
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
      // Wrapped rather than one long line: a green run that overflows the
      // terminal breaks at an arbitrary column and stops reading as one item
      // per separator, which is all this collapsed form has to convey.
      const titles = entries.map((e) => e.definition?.title ?? e.result.checkId)
      const indent = '    '
      const budget = VIEW_WIDTH - indent.length - 2
      let line = ''
      const flush = (): void => {
        if (!line) return
        out.push(`${indent}${style.colour}${style.glyph}${RESET} ${line}`)
        line = ''
      }
      for (const title of titles) {
        const next = line ? `${line} · ${title}` : title
        if (next.length > budget) {
          flush()
          line = title
        } else line = next
      }
      flush()
      continue
    }

    for (const { result, definition, notApplicable } of entries) {
      const title = definition?.title ?? result.checkId
      if (notApplicable) {
        out.push(
          `    ${style.colour}${style.glyph} ${title} — ${notApplicable}${RESET}`
        )
        continue
      }
      out.push(
        `    ${style.colour}${style.glyph}${RESET} ${BOLD}${title}${RESET}`
      )
      out.push(`        ${DIM}${result.checkId} · ${result.anchor}${RESET}`)
      out.push(`        expected  ${result.expected}`)
      out.push(`        observed  ${result.actual}`)
      if (result.detail) out.push(`        ${BLUE}→ ${result.detail}${RESET}`)
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
