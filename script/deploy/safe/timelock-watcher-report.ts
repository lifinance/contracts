/**
 * Renders the timelock watcher's run: the job summary covering every network
 * and operation, and the Slack text: what a human has to act on, plus held
 * updates riding along or sent alone as a digest.
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
 * The Slack posts for this run: what a human has to act on, then any held
 * updates riding along. Held updates alone make a digest that asks nothing.
 *
 * @param actionable - Updates a human has to act on.
 * @param digest - Held updates delivered with this post.
 * @param runUrl - Link to the run, when known.
 * @returns The posts, each under {@link SLACK_TEXT_BUDGET}, that together carry
 *   every update; none when there is nothing to send.
 */
export const renderSlackPosts = (
  actionable: readonly IAlertItem[],
  digest: readonly IAlertItem[],
  runUrl: string | undefined
): string[] => {
  if (actionable.length === 0 && digest.length === 0) return []
  const isMismatch = (a: IAlertItem): boolean =>
    a.kind !== 'resolved' && a.finding.verdict === 'mismatch'
  const mismatches = actionable.filter(isMismatch).length
  const unverified = actionable.length - mismatches
  const header =
    actionable.length === 0
      ? `ℹ️ Timelock watcher digest: ${digest.length} update(s) since the last post, nothing needs action.`
      : `${mismatches > 0 ? '🚨' : '⚠️'} Timelock watcher: ${[
          mismatches > 0 ? `${mismatches} mismatch` : '',
          unverified > 0 ? `${unverified} unverified` : '',
        ]
          .filter(Boolean)
          .join(', ')} to look at. Report-only, nothing was cancelled.`
  const line = (a: IAlertItem): string => {
    const verdict =
      a.kind === 'resolved'
        ? `now ok (was ${a.previous ?? 'unknown'})`
        : `${a.finding.verdict}${
            a.kind !== 'changed'
              ? ''
              : a.previous === a.finding.verdict
              ? ' (reasons changed)'
              : ` (was ${a.previous ?? 'unknown'})`
          }`
    const reason = a.finding.reasons[0] ? ` — ${a.finding.reasons[0]}` : ''
    const marker = a.kind === 'resolved' ? '✅' : '•'
    return `${marker} [${KIND_LABEL[a.kind]}] ${
      a.finding.key
    }: ${verdict}${reason}`
  }
  // Mismatches lead, so the first post shows every one it counts.
  const body = [
    ...actionable.filter(isMismatch),
    ...actionable.filter((a) => !isMismatch(a)),
  ].map(line)
  if (digest.length > 0) {
    if (body.length > 0) body.push('Since the last post, for information:')
    body.push(...digest.map(line))
  }
  const footer = runUrl ? `<${runUrl}|Full report>` : ''
  // Room for the header or a continuation line, and the footer.
  const room = SLACK_TEXT_BUDGET - header.length - footer.length - 2
  const chunks: string[][] = [[]]
  let used = 0
  for (const full of body) {
    const text = full.length > room ? `${full.slice(0, room - 1)}…` : full
    const current = chunks[chunks.length - 1] as string[]
    if (current.length > 0 && used + text.length + 1 > room) {
      chunks.push([text])
      used = text.length + 1
    } else {
      current.push(text)
      used += text.length + 1
    }
  }
  return chunks.map((lines, i) =>
    [
      i === 0 ? header : `(continued, ${i + 1} of ${chunks.length})`,
      ...lines,
      footer,
    ]
      .filter(Boolean)
      .join('\n')
  )
}
