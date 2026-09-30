/**
 * Alert dedupe for the report-only timelock watcher: which findings of this run
 * go to Slack, given what earlier runs already sent.
 *
 * Import it from `timelock-watcher.ts`. It is pure; the caller persists the
 * records it returns, and only once the alert carrying them was delivered.
 */

import {
  REQUIRED_CHECKS,
  type TWatcherVerdict,
} from './timelock-watcher-verdict'

/** A standing mismatch is re-sent every 6 hours until it resolves. */
export const MISMATCH_REALERT_MS = 6 * 60 * 60 * 1000 // 6 hours

/** A standing unverified finding is re-sent once a day. */
export const UNVERIFIED_REALERT_MS = 24 * 60 * 60 * 1000 // 24 hours

/** The last alert sent for one subject. */
export interface IAlertRecord {
  verdict: Exclude<TWatcherVerdict, 'ok'>
  /** ISO timestamp of the delivery. */
  alertedAt: string
  /** {@link reasonsSignature} of the reasons alerted; unset on older records. */
  reasons?: string
}

/** One subject this run judged: an operation, or a network as a whole. */
export interface IWatchFinding {
  /** `<network>:<operation id>` or `<network>:network`. */
  key: string
  network: string
  verdict: TWatcherVerdict
  reasons: string[]
}

export type TAlertKind = 'new' | 'changed' | 'repeat' | 'resolved'

export interface IAlertItem {
  finding: IWatchFinding
  kind: TAlertKind
  previous?: IAlertRecord['verdict']
}

export interface IAlertDecision {
  alerts: IAlertItem[]
  /** Records to persist once `alerts` has been delivered. */
  next: Record<string, IAlertRecord>
}

/**
 * The dedupe key of a finding.
 *
 * @param network - Network name.
 * @param subject - Operation id, or `network` for a network-level finding.
 * @returns The key.
 */
export const findingKey = (network: string, subject: string): string =>
  `${network.toLowerCase()}:${subject.toLowerCase()}`

const networkOfKey = (key: string): string => key.slice(0, key.indexOf(':'))

const CHECK_PREFIX = new RegExp(`^(${REQUIRED_CHECKS.join('|')}): `)

/** A network note saying the log scan missed an operation the queue holds. */
const COVERAGE_NOTE = /pending on chain but the log scan did not find it/

/**
 * What a standing verdict must gain to alert again: a check that fails under
 * a mismatch, a note on a mismatched network (its numbers and hex masked, its
 * error detail dropped), or a network note that the log scan missed an operation.
 * An unknown check comes and goes with node health, so it waits for the
 * repeat instead of paging on every flip.
 *
 * @param verdict - The finding's verdict.
 * @param reasons - Its reasons.
 * @returns A stable signature.
 */
export const reasonsSignature = (
  verdict: TWatcherVerdict,
  reasons: readonly string[]
): string =>
  [
    ...new Set(
      reasons.flatMap((reason) => {
        const entry = signatureEntry(verdict, reason)
        return entry === undefined ? [] : [entry]
      })
    ),
  ]
    .sort()
    .join('\n')

const signatureEntry = (
  verdict: TWatcherVerdict,
  reason: string
): string | undefined => {
  if (COVERAGE_NOTE.test(reason)) return reason
  const check = CHECK_PREFIX.exec(reason)?.[1]
  if (check) return verdict === 'mismatch' ? check : undefined
  if (verdict !== 'mismatch') return undefined
  return reason
    .replace(/: .*$/s, '')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/#x[#0-9a-fA-F]+/g, '0x…')
}

const entriesOf = (signature: string): Set<string> =>
  new Set(signature.split('\n').filter(Boolean))

/**
 * Decides which findings to alert on.
 *
 * - A finding with no record alerts when it is not `ok`.
 * - A change of verdict alerts, including the return to `ok`, and so does a
 *   {@link reasonsSignature} entry not seen since the last new or repeated
 *   alert; one that goes away and comes back does not page again until then.
 * - A standing verdict alerts again once its throttle has elapsed.
 * - An operation this run no longer reports, on a network it read completely,
 *   was executed or cancelled: that is announced and its record dropped. A
 *   network that could not be read keeps its records, so its return does not
 *   re-page.
 *
 * @param previous - Records the last run persisted.
 * @param findings - Everything this run judged.
 * @param settledNetworks - Networks read completely this run.
 * @param now - The time of this run.
 * @returns The alerts to send and the records to persist after delivery.
 */
export const decideAlerts = (
  previous: Readonly<Record<string, IAlertRecord>>,
  findings: readonly IWatchFinding[],
  settledNetworks: ReadonlySet<string>,
  now: Date
): IAlertDecision => {
  const alerts: IAlertItem[] = []
  const next: Record<string, IAlertRecord> = {}
  const seen = new Set<string>()
  const stamp = now.toISOString()

  for (const finding of findings) {
    seen.add(finding.key)
    const record = previous[finding.key]

    if (finding.verdict === 'ok') {
      if (record)
        alerts.push({ finding, kind: 'resolved', previous: record.verdict })
      continue
    }

    const reasons = reasonsSignature(finding.verdict, finding.reasons)
    const alerted = { verdict: finding.verdict, alertedAt: stamp, reasons }

    if (!record) {
      alerts.push({ finding, kind: 'new' })
      next[finding.key] = alerted
      continue
    }

    const throttle =
      finding.verdict === 'mismatch'
        ? MISMATCH_REALERT_MS
        : UNVERIFIED_REALERT_MS
    const elapsed = now.getTime() - Date.parse(record.alertedAt)
    // An unparseable stamp is NaN, which fails every comparison; treat it as
    // elapsed so a corrupt record cannot silence a subject for good.
    const due = !(elapsed < throttle)

    const stored = entriesOf(record.reasons ?? reasons)
    const union = [...new Set([...stored, ...entriesOf(reasons)])]
      .sort()
      .join('\n')
    const added = finding.reasons.find((reason) => {
      const entry = signatureEntry(finding.verdict, reason)
      return entry !== undefined && !stored.has(entry)
    })
    if (record.verdict !== finding.verdict || added !== undefined) {
      alerts.push({
        finding:
          added === undefined
            ? finding
            : {
                ...finding,
                reasons: [added, ...finding.reasons.filter((r) => r !== added)],
              },
        kind: 'changed',
        previous: record.verdict,
      })
      // A new entry under the same verdict keeps the repeat's clock and the
      // entries seen since, so two notes that take turns page once each; once
      // the repeat is due, this alert is the repeat.
      next[finding.key] =
        record.verdict !== finding.verdict || due
          ? alerted
          : { ...record, reasons: union }
      continue
    }

    if (due) {
      alerts.push({ finding, kind: 'repeat' })
      next[finding.key] = alerted
    } else next[finding.key] = { ...record, reasons: union }
  }

  for (const [key, record] of Object.entries(previous)) {
    if (seen.has(key)) continue
    const network = networkOfKey(key)
    if (!settledNetworks.has(network)) next[key] = record
    else if (key !== findingKey(network, 'network'))
      alerts.push({
        kind: 'resolved',
        previous: record.verdict,
        finding: {
          key,
          network,
          verdict: 'ok',
          reasons: ['no longer pending on chain'],
        },
      })
  }

  return { alerts, next }
}
