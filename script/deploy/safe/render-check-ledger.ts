/**
 * Console renderer for the check ledger.
 *
 * Import this from any script that runs pre-signing checks; it turns a ledger
 * from `check-ledger.ts` into the lines a signer reads. One line per section,
 * expanded per network only where a section is not green, and a single closing
 * verdict.
 *
 * Every count is printed as `N/N` against the declared denominator, and a
 * result that could not run is labelled `UNVERIFIED`, never folded into a green
 * line — the two states a signer must not be able to confuse.
 */

import { sanitizeProvenanceText } from '../shared/git-provenance'

import {
  checkResultKey,
  rollUpChecks,
  summariseLedger,
  type CheckClass,
  type ICheckLedger,
  type ICheckResult,
  type ICheckRollup,
  type ILedgerVerdict,
  type OpProfile,
} from './check-ledger'

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const CYAN = '\u001b[36m'
const RESET = '\u001b[0m'

/** Width of the network column in an expanded row. */
const NETWORK_WIDTH = 16
/** Width of the section column, so the counts line up down the report. */
const SECTION_WIDTH = 22

const color = (code: string, text: string): string => `${code}${text}${RESET}`

/**
 * Everything rendered here is a value some other machine reported — a chain, a
 * store, an anchor file — so it is treated exactly like proposer-supplied text:
 * a value carrying an escape sequence could otherwise repaint the verdict line
 * printed under it.
 */
const clean = (value: unknown): string => sanitizeProvenanceText(value)

type RowKind = 'fail' | 'error' | 'needs-ack' | 'missing'

const ROW_LABEL: Record<RowKind, string> = {
  fail: 'MISMATCH',
  error: 'UNVERIFIED (could not run)',
  'needs-ack': 'NEEDS REVIEW',
  missing: 'UNVERIFIED (no result recorded)',
}

const ROW_ACTION: Record<RowKind, string> = {
  fail: 'do not sign — the observed value disagrees with the anchor',
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
      if (result.status === 'pass' || result.status === 'needs-ack') continue
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

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

function renderRow(
  network: string,
  kind: RowKind,
  facts: string[],
  options: { detail?: string; relaxed?: boolean; checkClass?: CheckClass } = {}
): string {
  const trailer = options.detail ? ` · ${clean(options.detail)}` : ''
  const action =
    kind === 'fail' && options.checkClass === 'semantic'
      ? SEMANTIC_FAIL_ACTION
      : ROW_ACTION[kind]

  return color(
    options.relaxed ? YELLOW : ROW_COLOR[kind],
    `      ${clean(network).padEnd(NETWORK_WIDTH)}${ROW_LABEL[kind]}${
      options.relaxed ? ` · ${RELAXED_LABEL}` : ''
    }  ${facts.filter(Boolean).join(' · ')}${trailer}  → ${
      options.relaxed ? RELAXED_ACTION : action
    }`
  )
}

function rowKind(result: ICheckResult): RowKind {
  if (result.status === 'fail') return 'fail'
  if (result.status === 'needs-ack') return 'needs-ack'

  // `error`, and anything the ledger's four statuses do not cover: the verdict
  // grades an unrecognised status as unverified with no acknowledgement path,
  // and the row has to say the same. Passes never reach here; the caller
  // filters them.
  return 'error'
}

function renderCheck(
  rollup: ICheckRollup,
  relaxed: ReadonlySet<string>
): string[] {
  const counts = [
    `pass ${rollup.passed}/${rollup.expected}`,
    rollup.failed > 0 ? `fail ${rollup.failed}` : '',
    rollup.needsAck > 0 ? `needs review ${rollup.needsAck}` : '',
    rollup.unverified > 0 ? `unverified ${rollup.unverified}` : '',
    `anchors ${clean(rollup.anchors.join(', ')) || 'none'}`,
  ]
    .filter(Boolean)
    .join(' · ')

  const lines = [
    color(
      rollup.failed > 0 ? RED : YELLOW,
      `  ✗ ${clean(rollup.checkId)} — ${clean(rollup.title)}  ${counts}`
    ),
  ]

  for (const result of rollup.results) {
    if (result.status === 'pass') continue

    lines.push(
      renderRow(
        result.network,
        rowKind(result),
        [
          `expected ${clean(result.expected)}`,
          `actual ${clean(result.actual)}`,
          `anchor ${clean(result.anchor)}`,
          // The disagreement this row replaced, when it replaced one. Without
          // it the row reads as a plain retry of a network that has already
          // disagreed once.
          ...(result.supersededMismatch === undefined
            ? []
            : [clean(result.supersededMismatch)]),
        ],
        {
          ...(result.detail === undefined ? {} : { detail: result.detail }),
          relaxed: relaxed.has(checkResultKey(result.checkId, result.network)),
          checkClass: rollup.checkClass,
        }
      )
    )
  }

  for (const network of rollup.missingNetworks)
    lines.push(renderRow(network, 'missing', ['anchor A-UNRESOLVED']))

  return lines
}

function renderSection(
  section: string,
  rollups: ICheckRollup[],
  relaxed: ReadonlySet<string>
): string[] {
  const greenChecks = rollups.filter((rollup) => rollup.green).length
  const passed = rollups.reduce((sum, rollup) => sum + rollup.passed, 0)
  const expected = rollups.reduce((sum, rollup) => sum + rollup.expected, 0)
  const unverified = rollups.reduce((sum, rollup) => sum + rollup.unverified, 0)
  const needsAck = rollups.reduce((sum, rollup) => sum + rollup.needsAck, 0)
  // Every recorded mismatch, integrity and semantic alike — `verdict.blocking`
  // carries a `fail` only for integrity. Deliberately not called "blocking"
  // here: a semantic mismatch is acknowledgeable, and a section line
  // contradicting the verdict below it is worse than a vaguer word. Unverified
  // keeps its own term, so one problem row still reads as one.
  const mismatched = rollups.reduce((sum, rollup) => sum + rollup.failed, 0)

  const allGreen = greenChecks === rollups.length
  const summary = [
    `${greenChecks}/${rollups.length} checks green`,
    `${passed}/${expected} network results verified`,
    mismatched > 0 ? `${mismatched} mismatch` : '',
    unverified > 0 ? `${unverified} unverified` : '',
    needsAck > 0 ? `${needsAck} needs review` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const lines = [
    color(
      allGreen ? GREEN : mismatched > 0 ? RED : YELLOW,
      `${allGreen ? '✓' : '✗'} ${clean(section).padEnd(
        SECTION_WIDTH
      )}${summary}`
    ),
  ]

  // A green check is fully described by the section line. Naming its networks
  // there would put 71 rows between the signer and the rows that need them.
  for (const rollup of rollups)
    if (!rollup.green) lines.push(...renderCheck(rollup, relaxed))

  return lines
}

function renderVerdict(
  verdict: ILedgerVerdict,
  rollups: ICheckRollup[]
): string {
  const passed = rollups.reduce((sum, rollup) => sum + rollup.passed, 0)
  const expected = rollups.reduce((sum, rollup) => sum + rollup.expected, 0)
  // Carried by every verdict: the run that verified 56 of 57 is the one whose
  // denominator has to be visible.
  const coverage = `${passed}/${expected} network results verified`

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

  if (verdict.relaxed.length > 0)
    return color(
      YELLOW,
      `VERDICT: NO BLOCKING RESULT —${relaxedNote.replace(
        ' · ',
        ' '
      )} · ${coverage}`
    )

  return color(
    GREEN,
    `VERDICT: ALL CHECKS GREEN — ${
      rollups.filter((rollup) => rollup.green).length
    }/${rollups.length} checks, ${passed}/${expected} network results verified`
  )
}

/**
 * Renders the whole ledger as printable lines.
 *
 * @param ledger - The run's ledger.
 * @param options - `triageProfile` applies the T2-narrowed relaxation before rendering.
 * @returns The header, one line per section plus the expanded non-green rows, and the verdict last.
 */
export function renderCheckLedger(
  ledger: ICheckLedger,
  options: { triageProfile?: OpProfile } = {}
): string[] {
  const rollups = rollUpChecks(ledger)
  const verdict = summariseLedger(ledger, options)
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
      color(
        YELLOW,
        `  ⚠ ${plural(
          cause.rows,
          'unverified result'
        )} below, all for one reason: ${
          cause.detail
        }. Fix that and re-run; retrying the checks on their own will not change the answer.`
      )
    )

  for (const [section, sectionRollups] of sections)
    lines.push(...renderSection(section, sectionRollups, relaxed))

  lines.push(renderVerdict(verdict, rollups))

  return lines
}
