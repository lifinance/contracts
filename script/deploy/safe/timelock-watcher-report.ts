/**
 * Renders the timelock watcher's run: the job summary covering every network
 * and operation, and the Slack text for the alerts the dedupe let through.
 *
 * Import it from `timelock-watcher.ts`. Pure; values taken from calldata are
 * limited to ids, addresses and numbers, which carry no markup.
 */

import type { IAlertItem } from './timelock-watcher-alerts'
import type { ICheckOutcome, TWatcherVerdict } from './timelock-watcher-verdict'

/** Keeps a Slack post under the webhook's text limit. */
export const SLACK_TEXT_BUDGET = 2800

export type TNetworkStatus = 'watched' | 'skipped' | 'unreadable' | 'uncovered'

export interface IOperationReport {
  id: string
  calls: number
  scheduledInBlock: string
  verdict: TWatcherVerdict
  checks: ICheckOutcome[]
  reasons: string[]
  /** The cancel matrix's recommendation, for information only. */
  cancelRecommendation: string
  notes: string[]
}

export interface INetworkReport {
  network: string
  status: TNetworkStatus
  /** Why a network is skipped, unreadable or uncovered, or what limits it. */
  reason?: string
  timelock?: string
  verdict: TWatcherVerdict
  scan?: {
    floor: string
    low: string
    high: string
    historyComplete: boolean
    logCalls: number
    scheduledLogs: number
  }
  operations: IOperationReport[]
  notes: string[]
}

const VERDICT_MARK: Record<TWatcherVerdict, string> = {
  ok: '✓ ok',
  mismatch: '✗ mismatch',
  unverified: '? unverified',
}

const cell = (text: string): string =>
  text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/**
 * Share of `[floor, head]` the scan covers.
 *
 * @param scan - The network's scan interval.
 * @returns A percentage string.
 */
export const coverageOf = (
  scan: NonNullable<INetworkReport['scan']>
): string => {
  const floor = BigInt(scan.floor)
  const high = BigInt(scan.high)
  const low = BigInt(scan.low)
  if (scan.historyComplete || high <= floor) return '100%'
  const covered = Number(((high - low + 1n) * 10_000n) / (high - floor + 1n))
  return `${(covered / 100).toFixed(2)}%`
}

/**
 * Totals across the fleet, for the summary headline and the exit code.
 *
 * @param reports - One report per network considered.
 * @returns The counts.
 */
export const tallyReports = (
  reports: readonly INetworkReport[]
): {
  networks: number
  watched: number
  skipped: number
  unreadable: number
  uncovered: number
  historyIncomplete: number
  operations: number
  byVerdict: Record<TWatcherVerdict, number>
} => {
  const byVerdict: Record<TWatcherVerdict, number> = {
    ok: 0,
    mismatch: 0,
    unverified: 0,
  }
  for (const report of reports)
    for (const op of report.operations) byVerdict[op.verdict]++
  return {
    networks: reports.length,
    watched: reports.filter((r) => r.status === 'watched').length,
    skipped: reports.filter((r) => r.status === 'skipped').length,
    unreadable: reports.filter((r) => r.status === 'unreadable').length,
    uncovered: reports.filter((r) => r.status === 'uncovered').length,
    historyIncomplete: reports.filter(
      (r) => r.scan !== undefined && !r.scan.historyComplete
    ).length,
    operations: reports.reduce((n, r) => n + r.operations.length, 0),
    byVerdict,
  }
}

/**
 * The job summary: a headline, one row per network, then one block per
 * pending operation with every check's outcome.
 *
 * @param reports - One report per network considered.
 * @param generatedAt - The run's time.
 * @returns Markdown for `$GITHUB_STEP_SUMMARY`.
 */
export const renderJobSummary = (
  reports: readonly INetworkReport[],
  generatedAt: Date
): string => {
  const t = tallyReports(reports)
  const lines: string[] = [
    '# Timelock watcher (report-only)',
    '',
    `${generatedAt.toISOString()} · ${t.networks} network(s): ${
      t.watched
    } watched, ${t.unreadable} unreadable, ${t.uncovered} not covered, ${
      t.skipped
    } skipped · ${t.historyIncomplete} with history still being scanned`,
    '',
    `${t.operations} pending operation(s): ${t.byVerdict.mismatch} mismatch, ${t.byVerdict.unverified} unverified, ${t.byVerdict.ok} ok`,
    '',
    '| Network | Status | Verdict | Timelock | History scanned | Schedule logs read | Pending | Note |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of reports)
    lines.push(
      `| ${r.network} | ${r.status} | ${VERDICT_MARK[r.verdict]} | ${
        r.timelock ?? ''
      } | ${r.scan ? coverageOf(r.scan) : ''} | ${
        r.scan ? r.scan.scheduledLogs : ''
      } | ${r.status === 'watched' ? r.operations.length : ''} | ${cell(
        [r.reason, ...r.notes].filter(Boolean).join('; ')
      )} |`
    )

  for (const r of reports)
    for (const op of r.operations) {
      lines.push(
        '',
        `## ${r.network} · \`${op.id}\` · ${VERDICT_MARK[op.verdict]}`,
        '',
        `${op.calls} call(s), scheduled in block ${op.scheduledInBlock}. Cancel matrix, for information only (the watcher does not simulate execution, so its executability leg is always unknown): ${op.cancelRecommendation}`,
        '',
        '| Check | Outcome | Detail |',
        '| --- | --- | --- |',
        ...op.checks.map(
          (c) => `| ${c.check} | ${c.status} | ${cell(c.detail)} |`
        )
      )
      if (op.notes.length > 0)
        lines.push('', ...op.notes.map((n) => `- ${cell(n)}`))
    }
  return `${lines.join('\n')}\n`
}

const KIND_LABEL: Record<IAlertItem['kind'], string> = {
  new: 'new',
  changed: 'changed',
  repeat: 'still',
  resolved: 'resolved',
}

/**
 * The Slack text for this run's alerts, or `undefined` when there are none.
 *
 * @param alerts - What the dedupe let through.
 * @param runUrl - Link to the run, when known.
 * @returns The message text, trimmed to {@link SLACK_TEXT_BUDGET}.
 */
export const renderSlackAlert = (
  alerts: readonly IAlertItem[],
  runUrl: string | undefined
): string | undefined => {
  if (alerts.length === 0) return undefined
  const mismatches = alerts.filter(
    (a) => a.kind !== 'resolved' && a.finding.verdict === 'mismatch'
  ).length
  const header = `${
    mismatches > 0 ? '🚨' : '⚠️'
  } Timelock watcher: ${mismatches} mismatch, ${
    alerts.length - mismatches
  } other update(s). Report-only, nothing was cancelled.`
  // Mismatches lead, so a truncated post still shows every one it counts.
  const rank = (a: IAlertItem): number =>
    a.kind !== 'resolved' && a.finding.verdict === 'mismatch' ? 0 : 1
  const body = [...alerts]
    .sort((a, b) => rank(a) - rank(b))
    .map((a) => {
      const verdict =
        a.kind === 'resolved'
          ? `now ok (was ${a.previous ?? 'unknown'})`
          : `${a.finding.verdict}${
              a.kind === 'changed' ? ` (was ${a.previous ?? 'unknown'})` : ''
            }`
      const reason = a.finding.reasons[0] ? ` — ${a.finding.reasons[0]}` : ''
      return `• [${KIND_LABEL[a.kind]}] ${a.finding.key}: ${verdict}${reason}`
    })
  const footer = runUrl ? `<${runUrl}|Full report>` : ''
  let text = [header, ...body, footer].filter(Boolean).join('\n')
  if (text.length > SLACK_TEXT_BUDGET) {
    const suffix = `\n… truncated. ${footer}`
    text = `${text.slice(0, SLACK_TEXT_BUDGET - suffix.length)}${suffix}`
  }
  return text
}
