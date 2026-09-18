/**
 * Console renderer for the check ledger.
 *
 * Import this from any script that runs pre-signing checks; it turns a ledger
 * from `check-ledger.ts` into the lines a signer reads. One line per section,
 * expanded per network only where a section is not green — each such row as
 * `expected` and `observed` on their own lines and one `→` remedy — and a
 * single closing verdict, or that closing verdict alone when the run graded
 * nothing. Every line folds at the signer view's width.
 *
 * Every count is printed as `N/N` against the networks that were graded, always
 * beside the count of those that had nothing to grade. A result that could not
 * run is labelled `UNVERIFIED`, never folded into a green line, and a run that
 * graded nothing prints that one `NOTHING TO REVIEW` line and nothing else —
 * the states a signer must not be able to confuse.
 */

import { sanitizeProvenanceText } from '../shared/git-provenance'

import {
  checkResultKey,
  gateLabel,
  rollUpChecks,
  summariseLedger,
  type CheckClass,
  type ICheckLedger,
  type ICheckResult,
  type ICheckRollup,
  type ILedgerVerdict,
  type OpProfile,
} from './check-ledger'
import { VIEW_WIDTH } from './signer-view'

const ESC = '\u001b'
const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'
const BOLD = '\u001b[1m'
const RESET = '\u001b[0m'

/** Width of the network column in an expanded row. */
const NETWORK_WIDTH = 16
/** Width of the section column, so the counts line up down the report. */
const SECTION_WIDTH = 22
/** The ledger shares a terminal with the signer view, so it folds at the same column. */
// consola prefixes every line with a glyph and a space, so a line folded to
// the full view width still wraps on the terminal's edge.
const LEDGER_WIDTH = VIEW_WIDTH - 2
const ROW_INDENT = '      '
const VALUE_INDENT = '        '
/** `expected` and `observed` padded to one column, so the two values stack. */
const VALUE_LABEL_WIDTH = 10
const VERDICT_HANG = ' '.repeat('VERDICT: '.length)

const color = (code: string, text: string): string => `${code}${text}${RESET}`

const SGR = new RegExp(`${ESC}[[][0-9;]*m`, 'gu')
const visibleWidth = (text: string): number => text.replace(SGR, '').length

/** Separates the phrases of a summary line; a fold prefers to land on it. */
const PHRASE_SEPARATOR = ' · '

/**
 * Folds a value under a hanging indent, never inside a word: an address or a
 * hash split across two lines cannot be searched for, so a word longer than the
 * budget takes a line of its own. A phrase that fits on a line of its own is
 * moved there whole rather than split, so a count is never parted from its noun.
 *
 * @param prefix - Printed once, ahead of the first line.
 * @param value - The text to fold; its whitespace runs are already single spaces.
 * @param hang - The indent of every continuation line; defaults to the prefix's width.
 * @returns At least one line, each within the ledger width where its words allow.
 */
const wrap = (
  prefix: string,
  value: string,
  hang = ' '.repeat(visibleWidth(prefix))
): string[] => {
  const folded: string[] = []
  let line = ''
  let budget = LEDGER_WIDTH - visibleWidth(prefix)
  const fold = (): void => {
    folded.push(line)
    line = ''
    budget = LEDGER_WIDTH - hang.length
  }

  for (const phrase of value.split(PHRASE_SEPARATOR)) {
    if (
      line &&
      `${line}${PHRASE_SEPARATOR}${phrase}`.length > budget &&
      phrase.length <= LEDGER_WIDTH - hang.length
    )
      fold()

    let separator = line ? PHRASE_SEPARATOR : ''
    for (const word of phrase.split(' ').filter(Boolean)) {
      const next = `${line}${separator}${word}`
      if (line && next.length > budget) {
        fold()
        line = word
      } else line = next
      separator = ' '
    }
  }
  if (line) folded.push(line)

  if (folded.length === 0) return [prefix.trimEnd()]
  return folded.map((text, position) =>
    position === 0 ? `${prefix}${text}` : `${hang}${text}`
  )
}

const valueLines = (label: string, value: string): string[] =>
  wrap(`${VALUE_INDENT}${label.padEnd(VALUE_LABEL_WIDTH)}`, clean(value))

/**
 * Re-folds one coloured line, keeping its colour on every piece.
 *
 * @param line - A line of the form `<code>text<reset>`, as `color` builds it.
 * @param hang - The indent of the continuation lines.
 * @returns The line, or the folded lines that replace it.
 */
const refold = (line: string, hang: string): string[] => {
  const code = line.startsWith(ESC) ? line.slice(0, line.indexOf('m') + 1) : ''
  return wrap('', line.replace(SGR, ''), hang).map((text) =>
    code ? color(code, text) : text
  )
}

/**
 * Everything rendered here is a value some other machine reported — a chain, a
 * store, an anchor file — so it is treated exactly like proposer-supplied text:
 * a value carrying an escape sequence could otherwise repaint the verdict line
 * printed under it.
 */
const clean = (value: unknown): string => sanitizeProvenanceText(value)

type RowKind = 'fail' | 'error' | 'needs-ack' | 'missing' | 'not-applicable'

const ROW_LABEL: Record<RowKind, string> = {
  fail: 'MISMATCH',
  error: 'UNVERIFIED (could not run)',
  'needs-ack': 'NEEDS REVIEW',
  missing: 'UNVERIFIED (no result recorded)',
  'not-applicable': 'NOT APPLICABLE',
}

const ROW_ACTION: Record<Exclude<RowKind, 'not-applicable'>, string> = {
  fail: 'do not sign — what was observed is not what was expected',
  error: 'retry the check — an unverified check has no acknowledgement path',
  'needs-ack': 'review the change and acknowledge it',
  missing: 're-run this check on this network before signing',
}

/**
 * How many unverified rows have to share one cause before the report states it
 * once rather than once per row.
 *
 * Two, because the defect this closes is arithmetic rather than aesthetic: one
 * unset `ETH_NODE_URI_<NETWORK>` failed ten separate checks, each of which then
 * printed "retry the check" — ten lines of advice that cannot work, above the
 * one line naming the cause that can be acted on.
 */
const SHARED_CAUSE_MIN_ROWS = 2

/**
 * The single cause behind every unverified row, when they all share one.
 *
 * Only when they *all* do, and only when nothing disagreed: a run where nine
 * rows blame a missing endpoint and one blames something else has two problems,
 * and a banner naming the first sends the signer to fix an environment that was
 * never the whole story.
 *
 * @param rollups - Every check's roll-up for this run.
 * @returns The shared cause and how many rows rest on it, or nothing.
 */
const sharedUnverifiedCause = (
  rollups: readonly ICheckRollup[]
): { detail: string; rows: number } | undefined => {
  const details = new Set<string>()
  let rows = 0

  for (const rollup of rollups)
    for (const result of rollup.results) {
      if (
        result.status === 'pass' ||
        result.status === 'needs-ack' ||
        result.status === 'not-applicable'
      )
        continue
      if (result.status === 'fail') return undefined
      rows += 1
      details.add(clean(result.detail ?? ''))
    }

  const [only] = [...details]
  if (details.size !== 1 || !only || rows < SHARED_CAUSE_MIN_ROWS)
    return undefined
  return { detail: only, rows }
}

const ROW_COLOR: Record<RowKind, string> = {
  fail: RED,
  error: YELLOW,
  'needs-ack': CYAN,
  missing: YELLOW,
  'not-applicable': CYAN,
}

/**
 * A semantic mismatch is acknowledgeable, so telling the signer not to sign
 * would contradict the verdict printed below it. Only an integrity mismatch is
 * the end of the road.
 */
const SEMANTIC_FAIL_ACTION =
  'review the disagreement and acknowledge it, or stop'

const RELAXED_LABEL = 'relaxed by triage'
const RELAXED_ACTION =
  'no action — a subtractive-op triage dropped the acknowledgement'

const plural = (count: number, noun: string, many = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : many}`

const needReview = (count: number): string =>
  `${count} ${count === 1 ? 'needs' : 'need'} review`

/**
 * The networks a set of checks had nothing to grade on.
 *
 * Counted as networks everywhere a line aggregates across checks, so the same
 * skip is not reported as one number by the section and another by the verdict.
 */
/**
 * A gate every declared network answered "nothing here to grade" on.
 *
 * The section line and the closing verdict both divide by this, from this one
 * predicate: they are printed four lines apart and a signer reads them as one
 * sentence, so two counts that disagree about what "a check" means is the
 * contradiction this report exists to keep off the screen.
 *
 * `notApplicable === expected` rather than `graded === 0`: a check whose
 * networks all failed to answer also grades nothing, and that is a hole, not a
 * gate standing down.
 */
const stoodDown = (rollup: ICheckRollup): boolean =>
  rollup.graded === 0 && rollup.notApplicable === rollup.expected

const skippedNetworks = (rollups: readonly ICheckRollup[]): Set<string> =>
  new Set(
    rollups
      .flatMap((rollup) => rollup.results)
      .filter((result) => result.status === 'not-applicable')
      .map((result) => result.network)
  )

interface IRow {
  network: string
  kind: RowKind
  expected?: string
  observed?: string
  /** The check's own next step, printed after the generic action. */
  detail?: string
  relaxed?: boolean
  proposalNonce?: string
  checkClass?: CheckClass
}

function renderRow(row: IRow): string[] {
  const paint = (line: string): string =>
    color(row.relaxed ? YELLOW : ROW_COLOR[row.kind], line)
  const header = `${ROW_INDENT}${clean(row.network).padEnd(NETWORK_WIDTH)}${
    ROW_LABEL[row.kind]
  }${row.relaxed ? ` · ${RELAXED_LABEL}` : ''}${
    row.proposalNonce === undefined
      ? ''
      : ` · nonce ${clean(row.proposalNonce)}`
  }`

  if (row.kind === 'not-applicable')
    return wrap(`${header}  `, clean(row.observed ?? '')).map(paint)

  const action = row.relaxed
    ? RELAXED_ACTION
    : row.kind === 'fail' && row.checkClass === 'semantic'
    ? SEMANTIC_FAIL_ACTION
    : ROW_ACTION[row.kind]
  const remedy = row.detail ? `${action} · ${clean(row.detail)}` : action

  return [
    paint(header),
    ...(row.expected === undefined ? [] : valueLines('expected', row.expected)),
    ...(row.observed === undefined
      ? []
      : valueLines('observed', row.observed).map(paint)),
    ...wrap(`${VALUE_INDENT}→ `, remedy).map(paint),
  ]
}

function rowKind(result: ICheckResult): RowKind {
  if (result.status === 'fail') return 'fail'
  if (result.status === 'needs-ack') return 'needs-ack'
  if (result.status === 'not-applicable') return 'not-applicable'

  // `error`, and anything the ledger's own statuses do not cover: the verdict
  // grades an unrecognised status as unverified with no acknowledgement path,
  // and the row has to say the same. A pass and a not-applicable never reach
  // here; the caller filters both.
  return 'error'
}

function renderCheck(
  rollup: ICheckRollup,
  relaxed: ReadonlySet<string>
): string[] {
  // A check that graded nothing has no count to print: `pass 0/0` is the
  // vacuous claim this report exists to keep off the screen.
  const nothingGraded = rollup.graded === 0
  const counts = [
    nothingGraded
      ? 'nothing to grade'
      : `${rollup.passed}/${rollup.graded} network results verified`,
    rollup.failed > 0 ? plural(rollup.failed, 'mismatch', 'mismatches') : '',
    rollup.needsAck > 0 ? needReview(rollup.needsAck) : '',
    rollup.unverified > 0 ? `${rollup.unverified} unverified` : '',
    // Printed whenever the denominator above is smaller than the declared one,
    // so `1/1` on a two-network run can never be read as full coverage.
    rollup.notApplicable > 0
      ? `${plural(rollup.notApplicable, 'network')} not applicable`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const code = nothingGraded ? CYAN : rollup.failed > 0 ? RED : YELLOW
  const label = clean(gateLabel(rollup))
  // Neither tick nor cross for a check with nothing to grade, for the same
  // reason the section line carries neither.
  const [title = '', ...overflow] = wrap(
    `  ${nothingGraded ? '·' : '✗'} ${label}  `,
    counts,
    '    '
  )
  const lines = [
    color(
      code,
      title.replace(label, () => `${BOLD}${label}${RESET}${code}`)
    ),
    ...overflow.map((line) => color(code, line)),
  ]

  for (const result of rollup.results) {
    if (result.status === 'pass') continue

    // A gate that stood down everywhere is expanded so its reason is on
    // screen: the line above says it graded nothing but never why, and the why
    // is what a signer is asking for. Where the gate did grade somewhere, a
    // per-network skip is a coverage footnote the count already carries, and
    // expanding it would put 70 rows that need nothing above the rows that do.
    if (result.status === 'not-applicable') {
      if (nothingGraded)
        lines.push(
          ...renderRow({
            network: result.network,
            kind: 'not-applicable',
            observed: result.actual,
          })
        )
      continue
    }

    lines.push(
      ...renderRow({
        network: result.network,
        kind: rowKind(result),
        expected: result.expected,
        // The disagreement this row replaced travels with the observation.
        // Without it the row reads as a plain retry of a network that has
        // already disagreed once.
        observed:
          result.supersededMismatch === undefined
            ? result.actual
            : `${result.actual} · ${result.supersededMismatch}`,
        ...(result.detail === undefined ? {} : { detail: result.detail }),
        ...(result.proposalNonce === undefined
          ? {}
          : { proposalNonce: result.proposalNonce }),
        relaxed: relaxed.has(checkResultKey(result.checkId, result.network)),
        checkClass: rollup.checkClass,
      })
    )
  }

  for (const network of rollup.missingNetworks)
    lines.push(...renderRow({ network, kind: 'missing' }))

  return lines
}

function renderSection(
  section: string,
  rollups: ICheckRollup[],
  relaxed: ReadonlySet<string>
): string[] {
  const greenChecks = rollups.filter((rollup) => rollup.green).length
  const passed = rollups.reduce((sum, rollup) => sum + rollup.passed, 0)
  const graded = rollups.reduce((sum, rollup) => sum + rollup.graded, 0)
  const notApplicable = skippedNetworks(rollups).size
  const unverified = rollups.reduce((sum, rollup) => sum + rollup.unverified, 0)
  const needsAck = rollups.reduce((sum, rollup) => sum + rollup.needsAck, 0)
  // Every recorded mismatch, integrity and semantic alike — `verdict.blocking`
  // carries a `fail` only for integrity. Deliberately not called "blocking"
  // here: a semantic mismatch is acknowledgeable, and a section line
  // contradicting the verdict below it is worse than a vaguer word. Unverified
  // keeps its own term, so one problem row still reads as one.
  const mismatched = rollups.reduce((sum, rollup) => sum + rollup.failed, 0)

  // Nothing in this section was graded, so it has neither a verified count nor
  // a share of checks green: printing either would be a count over an empty
  // set, and `0/0` reads as coverage.
  const nothingGraded = graded === 0
  // Counted over the gates this proposal actually gave work to. A gate that
  // stood down is reported beside the fraction, never inside its denominator:
  // `5/6 checks green` on a run where the sixth had nothing to do reads as a
  // shortfall, and a signer cannot tell it from a gate that failed to report.
  const applicable = rollups.filter((rollup) => !stoodDown(rollup))
  const inapplicable = rollups.length - applicable.length
  const allGreen = greenChecks === applicable.length
  const summary = (
    nothingGraded
      ? [
          'nothing to grade',
          `${plural(notApplicable, 'network')} not applicable`,
        ]
      : [
          `${greenChecks}/${applicable.length} applicable checks green`,
          inapplicable > 0
            ? `${plural(inapplicable, 'gate')} not applicable`
            : '',
          `${passed}/${graded} network results verified`,
          mismatched > 0 ? plural(mismatched, 'mismatch', 'mismatches') : '',
          unverified > 0 ? `${unverified} unverified` : '',
          needsAck > 0 ? needReview(needsAck) : '',
          notApplicable > 0
            ? `${plural(notApplicable, 'network')} not applicable`
            : '',
        ]
  )
    .filter(Boolean)
    .join(' · ')

  const code = nothingGraded
    ? CYAN
    : allGreen
    ? GREEN
    : mismatched > 0
    ? RED
    : YELLOW
  // Neither tick nor cross: a section with nothing to grade is not a
  // success, and marking it as a failure would send a signer hunting for a
  // problem that is not there.
  const lines = wrap(
    `${nothingGraded ? '·' : allGreen ? '✓' : '✗'} ${clean(section).padEnd(
      SECTION_WIDTH
    )}`,
    summary
  ).map((line) => color(code, line))

  // A green check is fully described by the section line. Naming its networks
  // there would put 71 rows between the signer and the rows that need them.
  // Every other check is expanded, including one that graded nothing: the
  // section line counts it as not green, so suppressing it leaves a `✗` section
  // whose shortfall has no row explaining it.
  for (const rollup of rollups)
    if (!rollup.green) lines.push(...renderCheck(rollup, relaxed))

  return lines
}

/** How many skip notes a closing line names before it stops listing them. */
const MAX_SKIP_NOTES = 3

function renderNothingToReview(rollups: ICheckRollup[]): string {
  const notes = [
    ...new Set(
      rollups
        .flatMap((rollup) => rollup.results)
        .filter((result) => result.status === 'not-applicable')
        .map((result) => clean(result.actual))
    ),
  ]
  const shown = notes.slice(0, MAX_SKIP_NOTES)
  const elided = notes.length - shown.length

  return color(
    YELLOW,
    `VERDICT: NOTHING TO REVIEW — nothing was graded, so nothing was verified · ${plural(
      skippedNetworks(rollups).size,
      'network'
    )} had nothing to grade · ${shown.join(' · ')}${
      elided > 0 ? ` · +${elided} more` : ''
    }`
  )
}

function renderVerdict(
  verdict: ILedgerVerdict,
  rollups: ICheckRollup[]
): string {
  const passed = rollups.reduce((sum, rollup) => sum + rollup.passed, 0)
  const graded = rollups.reduce((sum, rollup) => sum + rollup.graded, 0)
  const notApplicable = skippedNetworks(rollups).size
  const skippedNote =
    notApplicable > 0
      ? ` · ${plural(notApplicable, 'network')} not applicable`
      : ''
  // Carried by every verdict: the run that verified 56 of 57 is the one whose
  // denominator has to be visible — and the skipped count travels with it, so a
  // denominator smaller than the declared network set always says why.
  const coverage = `${passed}/${graded} network results verified${skippedNote}`

  const relaxedNote =
    verdict.relaxed.length > 0
      ? ` · ${verdict.relaxed.length} ${RELAXED_LABEL}`
      : ''

  if (verdict.hardBlocked) {
    const unverified = verdict.blocking.filter(
      (entry) => entry.status !== 'fail'
    ).length

    return color(
      RED,
      `VERDICT: BLOCKED — ${plural(
        verdict.blocking.length,
        'blocking result'
      )} (${unverified} unverified, ${
        verdict.blocking.length - unverified
      } integrity mismatch) · no acknowledgement path${relaxedNote} · ${coverage}`
    )
  }

  if (verdict.requiresAcknowledgement.length > 0)
    return color(
      CYAN,
      `VERDICT: ACKNOWLEDGEMENT REQUIRED — ${plural(
        verdict.requiresAcknowledgement.length,
        'result'
      )} awaiting review${relaxedNote} · ${coverage}`
    )

  if (verdict.nothingGraded) return renderNothingToReview(rollups)

  if (verdict.relaxed.length > 0)
    return color(
      YELLOW,
      `VERDICT: NO BLOCKING RESULT —${relaxedNote.replace(
        ' · ',
        ' '
      )} · ${coverage}`
    )

  const green = rollups.filter((rollup) => rollup.green).length
  const notGreen = rollups.filter((rollup) => !rollup.green)

  // Nothing blocks and nothing is owed, but a check that graded nothing is not
  // a green check: `passed === graded` is measured over the graded networks
  // alone, so it cannot see one whose networks all dropped out of it.
  //
  // Which of the two closing lines it earns turns on *why* it graded nothing.
  // A gate every declared network answered "nothing here to grade" on has no
  // shortfall to chase — calling that run incomplete sends a signer hunting for
  // a gap that does not exist, and a warning nobody can act on is the fastest
  // way to teach them to read past this line. A gate that graded nothing
  // because a network never answered is a real hole and keeps the old wording.
  if (notGreen.length > 0) {
    if (!notGreen.every(stoodDown))
      return color(
        YELLOW,
        `VERDICT: COVERAGE INCOMPLETE — ${green}/${
          rollups.length
        } checks green, ${plural(
          rollups.filter((rollup) => rollup.graded === 0).length,
          'check'
        )} graded nothing · ${coverage}`
      )

    return color(
      GREEN,
      `VERDICT: ALL APPLICABLE CHECKS GREEN — ${green}/${
        rollups.length - notGreen.length
      } applicable checks, ${plural(
        notGreen.length,
        'gate'
      )} not applicable to this proposal · ${coverage}`
    )
  }

  return color(
    GREEN,
    `VERDICT: ALL CHECKS GREEN — ${green}/${rollups.length} checks, ${coverage}`
  )
}

/**
 * Renders the whole ledger as printable lines.
 *
 * @param ledger - The run's ledger.
 * @param options - `triageProfile` applies the T2-narrowed relaxation before rendering.
 * @returns The header, one line per section plus the expanded non-green rows, and the verdict last — or the closing line alone when the run graded nothing.
 */
export function renderCheckLedger(
  ledger: ICheckLedger,
  options: { triageProfile?: OpProfile } = {}
): string[] {
  const rollups = rollUpChecks(ledger)
  const verdict = summariseLedger(ledger, options)

  // Every section, and every check under it, can only report the same `nothing
  // to grade` the closing line already carries. `nothingGraded` is false the
  // moment any result was recorded, an unverified or a missing one included, so
  // no report that has something to say is silenced here.
  if (verdict.nothingGraded)
    return refold(renderNothingToReview(rollups), VERDICT_HANG)

  const relaxed = new Set(
    verdict.relaxed.map((result) =>
      checkResultKey(result.checkId, result.network)
    )
  )

  const sections = new Map<string, ICheckRollup[]>()
  for (const rollup of rollups) {
    const existing = sections.get(rollup.section)
    if (existing) existing.push(rollup)
    else sections.set(rollup.section, [rollup])
  }

  const lines = [
    `=== Check Ledger — ${plural(rollups.length, 'check')} × ${plural(
      ledger.expectedNetworks.length,
      'network'
    )} ===`,
  ]

  // Above the rows rather than below them: this is the only line in the report
  // a signer can act on when it applies, and the rows it explains are the ones
  // that would otherwise bury it.
  const cause = sharedUnverifiedCause(rollups)
  if (cause)
    lines.push(
      ...wrap(
        '  ⚠ ',
        `${plural(
          cause.rows,
          'unverified result'
        )} below, all for one reason: ${
          cause.detail
        }. Fix that and re-run; retrying the checks on their own will not change the answer.`,
        '    '
      ).map((line) => color(YELLOW, line))
    )

  for (const [section, sectionRollups] of sections)
    lines.push(...renderSection(section, sectionRollups, relaxed))

  lines.push(...refold(renderVerdict(verdict, rollups), VERDICT_HANG))

  return lines
}
