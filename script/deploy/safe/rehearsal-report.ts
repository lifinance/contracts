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

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  checkResultKey,
  type ICheckLedger,
  type ICheckResult,
} from './check-ledger'

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

/**
 * One row a signer has to answer for personally.
 */
export interface ISignerTask {
  readonly proposal: string
  readonly checkId: string
  readonly network: string
  readonly expected: string
  readonly actual: string
}

/**
 * What the run settled by itself, and what it is handing to the signer.
 */
export interface ISignerWorkload {
  /** Rows the evidence decided outright. Nothing to do. */
  readonly settled: number
  /** Rows that refused. Not the signer's to wave through — the run is blocked. */
  readonly blocked: number
  /** Rows where "is this the change we meant?" has no machine answer. */
  readonly needsYou: readonly ISignerTask[]
}

/**
 * Splits a run's rows by who has to act on them.
 *
 * The three buckets are the distinction the ledger already encodes and never
 * shows: an `integrity` check asks whether the bytes are what they claim, which
 * evidence settles; a `semantic` check asks whether this is the change we meant,
 * which only a person can answer, and that answer is the acknowledgement. A
 * report that prints one undifferentiated list of checks makes the signer
 * re-derive that split by eye on every proposal.
 *
 * `blocked` is deliberately not merged into `needsYou`: a refusal is not a
 * question put to the signer, and presenting it as one invites clicking
 * through it.
 *
 * @param pass - one pass's per-proposal ledgers
 * @returns the counts, and every row still waiting on a person
 */
export const summariseSignerWorkload = (
  pass: readonly {
    readonly proposal: string
    readonly ledger: ICheckLedger
  }[]
): ISignerWorkload => {
  let settled = 0
  let blocked = 0
  const needsYou: ISignerTask[] = []

  for (const entry of pass) {
    const outcomes = new Map<string, ICheckResult>()
    for (const result of entry.ledger.results)
      outcomes.set(checkResultKey(result.checkId, result.network), result)

    for (const result of outcomes.values())
      if (result.status === 'needs-ack')
        needsYou.push({
          proposal: entry.proposal,
          checkId: result.checkId,
          network: result.network,
          expected: result.expected,
          actual: result.actual,
        })
      else if (result.status === 'pass') settled += 1
      else blocked += 1
  }

  return { settled, blocked, needsYou }
}

/**
 * Renders the workload split for a signer.
 *
 * @param workload - the split
 * @returns a short block naming what is settled, what is blocked, and what is left
 */
export const renderSignerWorkload = (workload: ISignerWorkload): string => {
  const lines = [
    `settled automatically : ${workload.settled} row(s) — evidence decided these, nothing to do`,
    `blocked               : ${workload.blocked} row(s) — refused; not yours to wave through`,
    `needs your judgement  : ${workload.needsYou.length} row(s) — acknowledging one IS answering it`,
  ]
  for (const task of workload.needsYou.slice(0, 10))
    lines.push(
      `  ${task.checkId} on ${task.network}: expected ${task.expected}, observed ${task.actual}`
    )
  return lines.join('\n')
}

/** A file a gate's verdict rests on, and what its absence does to that verdict. */
export interface IGradingAnchor {
  readonly path: string
  readonly present: boolean
  /** What a run produces when this anchor is missing. */
  readonly consequence: string
}

/**
 * Checks the local files the gates grade against.
 *
 * A rehearsal in a fresh worktree is the case this exists for. The deployment
 * record is read from a gitignored cache, not from `deployments/*.json`, and
 * `resolveDeployedContractByAddress` returns `unrecorded` when it is absent —
 * so every cut element grades `contract-unidentified` and the run reports a
 * refusal on essentially every proposal. Nothing in that output says the cause
 * is a missing file, and the refusals are indistinguishable from real ones.
 *
 * The signing CLI does not have this hazard — it refreshes the cache from
 * MongoDB on every run so that every signer, not just the deployer, sees
 * current versions. The rehearsal inherits it precisely because it opens the
 * store by another route to avoid the index write on connect, and so never
 * reaches that warm-up.
 *
 * This is the false-refusal case the harness exists to catch, so it is checked
 * before grading rather than inferred from the results afterwards.
 *
 * @param rootDir - repo root the gates will read from
 * @returns one entry per anchor, with what its absence would cost
 */
export const checkGradingAnchors = (
  rootDir: string
): readonly IGradingAnchor[] => {
  const cachePath = join(rootDir, '.cache', 'deployments_production.json')
  return [
    {
      path: cachePath,
      present: existsSync(cachePath),
      consequence:
        'every cut element grades contract-unidentified, so the run refuses almost every proposal for a reason that is about this checkout rather than about the proposals. Run confirm-safe-tx.ts once to refresh it from MongoDB, or rehearse from a checkout that has it.',
    },
  ]
}

/**
 * Renders the anchor check.
 *
 * @param anchors - the checked anchors
 * @returns a line per anchor, naming the consequence of a missing one
 */
export const renderGradingAnchors = (
  anchors: readonly IGradingAnchor[]
): string =>
  anchors
    .map((anchor) =>
      anchor.present
        ? `present : ${anchor.path}`
        : `MISSING : ${anchor.path}\n          ${anchor.consequence}`
    )
    .join('\n')
