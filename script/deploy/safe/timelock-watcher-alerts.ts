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
  /** ISO time the subject was announced `ok`; the record is kept until its throttle ends. */
  resolvedAt?: string
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
 * - A resolved subject keeps its record until that throttle ends, so an
 *   unverified finding that flaps with node health is announced once, not on
 *   every flip; a mismatch that comes back alerts at once.
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

  const throttleOf = (verdict: IAlertRecord['verdict']): number =>
    verdict === 'mismatch' ? MISMATCH_REALERT_MS : UNVERIFIED_REALERT_MS
  // An unparseable stamp is NaN, which fails every comparison; treat it as
  // elapsed so a corrupt record cannot silence a subject for good.
  const isDue = (record: IAlertRecord): boolean =>
    !(now.getTime() - Date.parse(record.alertedAt) < throttleOf(record.verdict))

  for (const finding of findings) {
    seen.add(finding.key)
    const kept = previous[finding.key]

    if (finding.verdict === 'ok') {
      if (kept && kept.resolvedAt === undefined) {
        alerts.push({ finding, kind: 'resolved', previous: kept.verdict })
        next[finding.key] = { ...kept, resolvedAt: stamp }
      } else if (kept && !isDue(kept)) next[finding.key] = kept
      continue
    }

    const reopened =
      kept?.resolvedAt !== undefined &&
      kept.verdict === 'unverified' &&
      finding.verdict === 'unverified' &&
      !isDue(kept)
    const record = kept?.resolvedAt === undefined || reopened ? kept : undefined

    const reasons = reasonsSignature(finding.verdict, finding.reasons)
    const alerted = { verdict: finding.verdict, alertedAt: stamp, reasons }

    if (!record) {
      alerts.push({ finding, kind: 'new' })
      next[finding.key] = alerted
      continue
    }

    const due = isDue(record)

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
      // the repeat is due, this alert is the repeat. Either way the subject is
      // live again, so its next return to ok is announced.
      const { resolvedAt: _resolved, ...live } = record
      next[finding.key] =
        record.verdict !== finding.verdict || due
          ? alerted
          : { ...live, reasons: union }
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
    else if (
      key !== findingKey(network, 'network') &&
      record.resolvedAt === undefined
    )
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

/** A new unverified finding pages once it has held for this many consecutive runs. */
export const UNVERIFIED_PAGE_AFTER_RUNS = 3

/** Updates nobody has to act on are flushed in a digest at most this often. */
export const DIGEST_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24 hours

/** What decides when the watcher posts, carried between runs. */
export interface IDeliveryState {
  /** Consecutive runs each new, not yet alerted unverified finding was seen. */
  streaks: Record<string, number>
  /** Updates nobody has to act on, waiting for the next post. */
  held: IAlertItem[]
  /** ISO time of the last post; a digest is due {@link DIGEST_INTERVAL_MS} after it. */
  lastPostAt?: string
}

export interface IDeliveryPlan {
  /** Updates a human has to act on. */
  actionable: IAlertItem[]
  /** Held updates that ride along with this run's post; empty when nothing posts. */
  digest: IAlertItem[]
  /** Alert records to persist once the post was delivered, or at once when nothing posts. */
  next: Record<string, IAlertRecord>
  /** Delivery state to persist once the post was delivered, or at once when nothing posts. */
  delivered: IDeliveryState
  /** Delivery state to persist when the post could not be delivered. */
  undelivered: IDeliveryState
}

const isActionable = (alert: IAlertItem): boolean => {
  if (alert.kind === 'resolved') return false
  if (alert.finding.verdict === 'mismatch') return true
  if (alert.kind === 'new') return true
  // Under a standing unverified verdict, a change is a new coverage note: the
  // log scan missed an operation the queue holds.
  return alert.kind === 'changed' && alert.previous === 'unverified'
}

/**
 * Narrows {@link decideAlerts} to what a human has to act on. A new mismatch
 * pages at once; a new unverified finding only once it has held for
 * {@link UNVERIFIED_PAGE_AFTER_RUNS} runs, so an RPC blip pages nobody.
 * Resolutions and standing unverified repeats are held and ride along with the
 * next post, or go out as a digest once {@link DIGEST_INTERVAL_MS} has passed
 * since the last post.
 *
 * @param previous - Records the last run persisted.
 * @param decision - This run's {@link decideAlerts} result.
 * @param delivery - Delivery state the last run persisted.
 * @param settledNetworks - Networks read completely this run.
 * @param now - The time of this run.
 * @returns What to post and what to persist.
 */
export const planDelivery = (
  previous: Readonly<Record<string, IAlertRecord>>,
  decision: IAlertDecision,
  delivery: IDeliveryState,
  settledNetworks: ReadonlySet<string>,
  now: Date
): IDeliveryPlan => {
  const next = { ...decision.next }
  const streaks: Record<string, number> = {}
  const actionable: IAlertItem[] = []
  const heldByKey = new Map<string, IAlertItem>(
    delivery.held.map((item) => [item.finding.key, item])
  )

  for (const alert of decision.alerts) {
    const { key } = alert.finding
    if (alert.kind === 'new' && alert.finding.verdict === 'unverified') {
      // Kept past the threshold too, so an undelivered page re-sends next run.
      const streak = (delivery.streaks[key] ?? 0) + 1
      streaks[key] = streak
      if (streak < UNVERIFIED_PAGE_AFTER_RUNS) {
        const kept = previous[key]
        if (kept) next[key] = kept
        else delete next[key]
        continue
      }
    }
    heldByKey.delete(key)
    if (isActionable(alert)) actionable.push(alert)
    else heldByKey.set(key, alert)
  }
  // A network that could not be read reports none of its operations; that run
  // neither extends nor breaks their streaks.
  for (const [key, streak] of Object.entries(delivery.streaks))
    if (!(key in streaks) && !settledNetworks.has(networkOfKey(key)))
      streaks[key] = streak

  const held = [...heldByKey.values()]
  const lastPost =
    delivery.lastPostAt === undefined ? NaN : Date.parse(delivery.lastPostAt)
  const digestDue =
    held.length > 0 && !(now.getTime() - lastPost < DIGEST_INTERVAL_MS)
  const posts = actionable.length > 0 || digestDue
  const lastPostAt = delivery.lastPostAt ?? now.toISOString()

  return {
    actionable,
    digest: posts ? held : [],
    next,
    delivered: posts
      ? { streaks, held: [], lastPostAt: now.toISOString() }
      : { streaks, held, lastPostAt },
    undelivered: { streaks, held, lastPostAt },
  }
}
