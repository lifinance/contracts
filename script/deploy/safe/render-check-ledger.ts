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
  rollUpChecks,
  summariseLedger,
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
  error:
    'retry the check — an unverified check has no acknowledgement path (T3)',
  'needs-ack': 'review the change and acknowledge it',
  missing: 're-run this check on this network before signing',
}

const ROW_COLOR: Record<RowKind, string> = {
  fail: RED,
  error: YELLOW,
  'needs-ack': CYAN,
  missing: YELLOW,
}

const RELAXED_LABEL = 'relaxed by --triage'
const RELAXED_ACTION =
  'no action — a subtractive-op triage dropped the acknowledgement (T2)'

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

function renderRow(
  network: string,
  kind: RowKind,
  facts: string[],
  detail?: string,
  relaxed = false
): string {
  const trailer = detail ? ` · ${clean(detail)}` : ''

  return color(
    relaxed ? YELLOW : ROW_COLOR[kind],
    `      ${clean(network).padEnd(NETWORK_WIDTH)}${ROW_LABEL[kind]}${
      relaxed ? ` · ${RELAXED_LABEL}` : ''
    }  ${facts.filter(Boolean).join(' · ')}${trailer}  → ${
      relaxed ? RELAXED_ACTION : ROW_ACTION[kind]
    }`
  )
}

function rowKind(result: ICheckResult): RowKind {
  if (result.status === 'error') return 'error'
  if (result.status === 'needs-ack') return 'needs-ack'

  return 'fail'
}

function renderCheck(
  rollup: ICheckRollup,
  relaxed: ReadonlySet<ICheckResult>
): string[] {
  const counts = [
    `pass ${rollup.passed}/${rollup.expected}`,
    rollup.failed > 0 ? `fail ${rollup.failed}` : '',
    rollup.needsAck > 0 ? `needs review ${rollup.needsAck}` : '',
    rollup.unverified > 0 ? `unverified ${rollup.unverified}` : '',
    `anchors ${rollup.anchors.join(', ') || 'none'}`,
  ]
    .filter(Boolean)
    .join(' · ')

  const lines = [
    color(
      rollup.failed > 0 ? RED : YELLOW,
      `  ✗ ${rollup.checkId} — ${rollup.title}  ${counts}`
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
          `anchor ${result.anchor}`,
        ],
        result.detail,
        relaxed.has(result)
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
  verdict: ILedgerVerdict,
  relaxed: ReadonlySet<ICheckResult>
): string[] {
  const greenChecks = rollups.filter((rollup) => rollup.green).length
  const passed = rollups.reduce((sum, rollup) => sum + rollup.passed, 0)
  const expected = rollups.reduce((sum, rollup) => sum + rollup.expected, 0)
  const unverified = rollups.reduce((sum, rollup) => sum + rollup.unverified, 0)
  const blocking = verdict.blocking.filter((entry) =>
    rollups.some((rollup) => rollup.checkId === entry.checkId)
  ).length

  const allGreen = greenChecks === rollups.length
  const summary = [
    `${greenChecks}/${rollups.length} checks green`,
    `${passed}/${expected} network results verified`,
    blocking > 0 ? `${blocking} blocking` : '',
    unverified > 0 ? `${unverified} unverified` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  const lines = [
    color(
      allGreen ? GREEN : blocking > 0 ? RED : YELLOW,
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
  const relaxedNote =
    verdict.relaxed.length > 0
      ? ` · ${verdict.relaxed.length} relaxed by --triage`
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
      } integrity mismatch) · no acknowledgement path (T3)${relaxedNote}`
    )
  }

  if (verdict.requiresAcknowledgement.length > 0)
    return color(
      CYAN,
      `VERDICT: ACKNOWLEDGEMENT REQUIRED — ${plural(
        verdict.requiresAcknowledgement.length,
        'result'
      )} awaiting review${relaxedNote}`
    )

  if (verdict.relaxed.length > 0)
    return color(
      YELLOW,
      `VERDICT: NO BLOCKING RESULT —${relaxedNote.replace(' · ', ' ')}`
    )

  const passed = rollups.reduce((sum, rollup) => sum + rollup.passed, 0)
  const expected = rollups.reduce((sum, rollup) => sum + rollup.expected, 0)

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
  const relaxed = new Set(verdict.relaxed)

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

  for (const [section, sectionRollups] of sections)
    lines.push(...renderSection(section, sectionRollups, verdict, relaxed))

  lines.push(renderVerdict(verdict, rollups))

  return lines
}
