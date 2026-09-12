/**
 * The gate roster a verify rehearsal reports against, and how it renders.
 *
 * Import this from the rehearsal runner. It exists because the run's own
 * `CONFIRM_CHECK_DEFINITIONS` can only name gates that are merged, so a report
 * built from it alone is silent about the gates the design calls for and the
 * pipeline has not wired yet — and a rehearsal whose report shrinks as gates go
 * missing is a rehearsal that grades a smaller chain green every time.
 *
 * So the roster is a declared expectation, deliberately a superset of any one
 * commit, and every entry it holds appears in the report with a presence.
 */

/** Why the roster names a gate, so an entry can be retired on evidence. */
export interface IRosteredGate {
  readonly checkId: string
  readonly title: string
  /** Where the expectation comes from — a ticket, a merged module, a design doc. */
  readonly source: string
}

/**
 * Every gate the confirm chain is meant to compose onto the run ledger.
 *
 * Each entry names the source that is meant to register it. An entry whose
 * source has not merged reports `absent` rather than dropping out of the
 * report, which is the whole point: a roster that shrank to what is wired
 * would grade a smaller chain green every time one went missing.
 */
export const REHEARSAL_GATE_ROSTER: readonly IRosteredGate[] = [
  {
    checkId: 'INT-SAFE-ADDRESS',
    title: 'Safe address matches the configured one',
    source: 'confirm-integrity-asserts.ts, mirrored by EXSC-994',
  },
  {
    checkId: 'INT-SAFE-TX-HASH',
    title: 'Recomputed safeTxHash matches the stored one',
    source: 'confirm-integrity-asserts.ts, mirrored by EXSC-994',
  },
  {
    checkId: 'INT-SIGNATURES',
    title: 'Stored signatures resolve to current owners',
    source: 'confirm-integrity-asserts.ts, mirrored by EXSC-994',
  },
  {
    checkId: 'INT-FIXED-FIELDS',
    title: 'Fixed Safe tx fields carry their required values',
    source: 'confirm-integrity-asserts.ts, mirrored by EXSC-994',
  },
  {
    checkId: 'INT-TARGET',
    title: 'Target address is the diamond or timelock it claims',
    source: 'confirm-integrity-asserts.ts, mirrored by EXSC-994',
  },
  {
    checkId: 'INT-TIMELOCK-DELAY',
    title: 'Scheduled delay is at least the timelock minimum',
    source: 'confirm-integrity-asserts.ts, mirrored by EXSC-994',
  },
  {
    checkId: 'target-state',
    title: 'Facet version matches the declared target state',
    source: 'confirm-check-registry.ts (merged)',
  },
  {
    checkId: 'executability',
    title: 'The proposal would execute rather than revert',
    source: 'EXSC-994',
  },
  {
    checkId: 'rpc-quorum',
    title: 'Chain reads agreed across independent providers',
    source: 'EXSC-994',
  },
]

/**
 * `registered-but-silent` is kept apart from both neighbours on purpose. A gate
 * that registered and reported nothing is a different failure from one that was
 * never wired: the first is a gate that ran and answered for no network, which
 * the ledger counts as missing and blocks on, and reading it as `absent` would
 * blame the wrong thing.
 */
export type GatePresence = 'present' | 'registered-but-silent' | 'absent'

export interface IGateReportRow {
  readonly checkId: string
  readonly title: string
  readonly source: string
  readonly presence: GatePresence
  readonly rows: number
  /** False for a gate the run registered that the roster does not name. */
  readonly rostered: boolean
}

const presenceOf = (
  registered: readonly string[],
  rows: number,
  checkId: string
): GatePresence => {
  if (!registered.includes(checkId)) return 'absent'
  return rows > 0 ? 'present' : 'registered-but-silent'
}

/**
 * Grades every rostered gate, and every gate the run registered.
 *
 * A registered gate the roster does not name is appended rather than dropped:
 * the roster is an expectation, not an allow-list, and a chain that grew a gate
 * nobody rostered is something the reader has to be told about.
 *
 * @param run.registered - the check ids the run actually registered
 * @param run.rowCounts - rows each check recorded, keyed by check id
 * @returns one row per gate, rostered ones first, in roster order
 */
export const buildGateReport = (run: {
  registered: readonly string[]
  rowCounts: Readonly<Record<string, number>>
}): readonly IGateReportRow[] => {
  const rostered = REHEARSAL_GATE_ROSTER.map((gate) => ({
    ...gate,
    rows: run.rowCounts[gate.checkId] ?? 0,
    presence: presenceOf(
      run.registered,
      run.rowCounts[gate.checkId] ?? 0,
      gate.checkId
    ),
    rostered: true,
  }))

  const rosteredIds = new Set(REHEARSAL_GATE_ROSTER.map((gate) => gate.checkId))
  const unrostered = run.registered
    .filter((checkId) => !rosteredIds.has(checkId))
    .map((checkId) => ({
      checkId,
      title: 'Registered by the run; not on the rehearsal roster',
      source: 'unrostered',
      rows: run.rowCounts[checkId] ?? 0,
      presence: presenceOf(
        run.registered,
        run.rowCounts[checkId] ?? 0,
        checkId
      ),
      rostered: false,
    }))

  return [...rostered, ...unrostered]
}

/**
 * Renders the report as one line per gate.
 *
 * @param report - the graded gates
 * @returns a block naming every gate and its presence
 */
export const renderGateReport = (report: readonly IGateReportRow[]): string => {
  const width = Math.max(...report.map((gate) => gate.checkId.length))
  return report
    .map(
      (gate) =>
        `${gate.checkId.padEnd(width)}  ${gate.presence.padEnd(22)} rows=${
          gate.rows
        }  ${
          gate.presence === 'absent'
            ? `(expected from: ${gate.source})`
            : gate.title
        }`
    )
    .join('\n')
}
