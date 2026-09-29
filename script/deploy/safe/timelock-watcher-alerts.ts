/**
 * Alert dedupe for the report-only timelock watcher: which findings of this run
 * go to Slack, given what earlier runs already sent.
 *
 * Import it from `timelock-watcher.ts`. It is pure; the caller persists the
 * records it returns, and only once the alert carrying them was delivered.
 */

import type { TWatcherVerdict } from './timelock-watcher-verdict'

/** A standing mismatch is re-sent every 6 hours until it resolves. */
export const MISMATCH_REALERT_MS = 6 * 60 * 60 * 1000 // 6 hours

/** A standing unverified finding is re-sent once a day. */
export const UNVERIFIED_REALERT_MS = 24 * 60 * 60 * 1000 // 24 hours

/** The last alert sent for one subject. */
export interface IAlertRecord {
  verdict: Exclude<TWatcherVerdict, 'ok'>
  /** ISO timestamp of the delivery. */
  alertedAt: string
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

/**
 * Decides which findings to alert on.
 *
 * - A finding with no record alerts when it is not `ok`.
 * - A change of verdict alerts, including the return to `ok`.
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

    if (!record) {
      alerts.push({ finding, kind: 'new' })
      next[finding.key] = { verdict: finding.verdict, alertedAt: stamp }
      continue
    }

    if (record.verdict !== finding.verdict) {
      alerts.push({ finding, kind: 'changed', previous: record.verdict })
      next[finding.key] = { verdict: finding.verdict, alertedAt: stamp }
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
      next[finding.key] = { verdict: finding.verdict, alertedAt: stamp }
    } else next[finding.key] = record
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
