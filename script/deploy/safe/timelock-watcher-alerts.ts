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

/**
 * What must change for a standing verdict to alert again: which checks did not
 * pass, and which notes the network carries. Numbers, hex and error details are
 * dropped, so a backfill cursor moving or a node's error wording changing does
 * not re-page every run.
 *
 * @param reasons - A finding's reasons.
 * @returns A stable signature.
 */
export const reasonsSignature = (reasons: readonly string[]): string =>
  [
    ...new Set(
      reasons.map((reason) => {
        const check = CHECK_PREFIX.exec(reason)?.[1]
        if (check) return check
        return reason
          .replace(/: .*$/s, '')
          .replace(/0x[0-9a-fA-F]+/g, '0x…')
          .replace(/\d+(\.\d+)?/g, '#')
      })
    ),
  ]
    .sort()
    .join('\n')

/**
 * Decides which findings to alert on.
 *
 * - A finding with no record alerts when it is not `ok`.
 * - A change of verdict alerts, including the return to `ok`, and so does a
 *   change of {@link reasonsSignature} under the same verdict.
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

    const reasons = reasonsSignature(finding.reasons)
    const alerted = { verdict: finding.verdict, alertedAt: stamp, reasons }

    if (!record) {
      alerts.push({ finding, kind: 'new' })
      next[finding.key] = alerted
      continue
    }

    if (
      record.verdict !== finding.verdict ||
      (record.reasons !== undefined && record.reasons !== reasons)
    ) {
      alerts.push({ finding, kind: 'changed', previous: record.verdict })
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
    if (!(elapsed < throttle)) {
      alerts.push({ finding, kind: 'repeat' })
      next[finding.key] = alerted
    } else next[finding.key] = { ...record, reasons }
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
