/**
 * Tests for the timelock watcher's job summary and Slack text: every network
 * and operation reaches the summary, and the Slack text says what changed.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IAlertItem } from './timelock-watcher-alerts'
import {
  SLACK_TEXT_BUDGET,
  coverageOf,
  renderJobSummary,
  renderSlackPosts,
  tallyReports,
  type INetworkReport,
} from './timelock-watcher-report'

const NOW = new Date('2026-09-29T00:00:00.000Z')

const reports: INetworkReport[] = [
  {
    network: 'base',
    status: 'watched',
    verdict: 'mismatch',
    timelock: '0x5604A94A3438C3074EFFF803fab14B7244fe4E29',
    scan: {
      floor: '0',
      low: '0',
      high: '100',
      historyComplete: true,
      logCalls: 1,
      scheduledLogs: 3,
    },
    operations: [
      {
        id: '0xaaa',
        calls: 1,
        scheduledInBlock: '90',
        verdict: 'mismatch',
        checks: [{ check: 'targets', status: 'fail', detail: 'a | b' }],
        reasons: ['targets: a | b'],
        cancelRecommendation: 'cancel',
        notes: ['not in the execution queue'],
      },
    ],
    notes: [],
  },
  {
    network: 'sei',
    status: 'watched',
    verdict: 'unverified',
    timelock: '0x1',
    scan: {
      floor: '0',
      low: '750',
      high: '999',
      historyComplete: false,
      logCalls: 300,
      scheduledLogs: 0,
    },
    operations: [],
    notes: ['history before block 750 is not scanned yet'],
  },
  {
    network: 'tron',
    status: 'uncovered',
    verdict: 'unverified',
    reason: 'Tron is not covered',
    operations: [],
    notes: [],
  },
  {
    network: 'mainnet',
    status: 'unreadable',
    verdict: 'unverified',
    reason: 'the log scan failed',
    operations: [],
    notes: [],
  },
  {
    network: 'corn',
    status: 'skipped',
    verdict: 'ok',
    reason: 'no-timelock-deployed',
    operations: [],
    notes: [],
  },
]

const scanOf = (at: number): NonNullable<INetworkReport['scan']> => {
  const scan = reports[at]?.scan
  if (!scan) throw new Error(`fixture ${at} has no scan`)
  return scan
}

describe('coverageOf', () => {
  it('is 100% once history is complete', () => {
    expect(coverageOf(scanOf(0))).toBe('100%')
  })

  it('is the covered share of floor..head otherwise', () => {
    expect(coverageOf(scanOf(1))).toBe('25.00%')
  })
})

describe('tallyReports', () => {
  it('counts every status and verdict', () => {
    expect(tallyReports(reports)).toEqual({
      networks: 5,
      watched: 2,
      skipped: 1,
      unreadable: 1,
      uncovered: 1,
      historyIncomplete: 1,
      operations: 1,
      byVerdict: { ok: 0, mismatch: 1, unverified: 0 },
    })
  })
})

describe('renderJobSummary', () => {
  const summary = renderJobSummary(reports, NOW)

  it('has one row for every network, including skipped and unreadable ones', () => {
    for (const r of reports) expect(summary).toContain(`| ${r.network} |`)
  })

  it('has a block for every pending operation with each check', () => {
    expect(summary).toContain('## base · `0xaaa` · ✗ mismatch')
    expect(summary).toContain('| targets | fail | a \\| b |')
    expect(summary).toContain('- not in the execution queue')
  })

  it('escapes backslashes before pipes, so a cell cannot unescape its own delimiter', () => {
    const escaped = renderJobSummary(
      [
        {
          network: 'x',
          status: 'skipped',
          verdict: 'ok',
          reason: 'a\\|b',
          operations: [],
          notes: [],
        },
      ],
      NOW
    )
    expect(escaped).toContain('a\\\\\\|b')
  })

  it('says why a network is not covered or unreadable', () => {
    expect(summary).toContain('Tron is not covered')
    expect(summary).toContain('the log scan failed')
  })

  it('leads with the fleet totals', () => {
    expect(summary).toContain(
      '5 network(s): 2 watched, 1 unreadable, 1 not covered, 1 skipped'
    )
  })
})

const renderSlackAlert = (
  ...args: Parameters<typeof renderSlackPosts>
): string | undefined => {
  const posts = renderSlackPosts(...args)
  return posts.length > 0 ? posts.join('\n') : undefined
}

describe('renderSlackPosts', () => {
  const item = (
    kind: IAlertItem['kind'],
    verdict: IAlertItem['finding']['verdict'],
    previous?: IAlertItem['previous']
  ): IAlertItem => ({
    kind,
    ...(previous ? { previous } : {}),
    finding: {
      key: 'base:0xaaa',
      network: 'base',
      verdict,
      reasons: ['targets: unknown'],
    },
  })

  it('sends nothing when there is nothing to alert', () => {
    expect(renderSlackAlert([], undefined)).toBeUndefined()
  })

  it('leads with the mismatch count and names each subject', () => {
    const text = renderSlackAlert(
      [item('new', 'mismatch'), item('resolved', 'ok', 'unverified')],
      'https://example.test/run'
    )
    expect(text).toContain('🚨 Timelock watcher: 1 mismatch, 1 other')
    expect(text).toContain('• [new] base:0xaaa: mismatch — targets: unknown')
    expect(text).toContain('now ok (was unverified)')
    expect(text).toContain('<https://example.test/run|Full report>')
  })

  it('does not raise the siren for unverified alone', () => {
    const text = renderSlackAlert([item('new', 'unverified')], undefined)
    expect(text?.startsWith('⚠️')).toBe(true)
  })

  it('shows the previous verdict on a change', () => {
    expect(
      renderSlackAlert([item('changed', 'mismatch', 'unverified')], undefined)
    ).toContain('mismatch (was unverified)')
  })

  it('says the reasons changed when the verdict did not', () => {
    expect(
      renderSlackAlert([item('changed', 'unverified', 'unverified')], undefined)
    ).toContain('unverified (reasons changed)')
  })

  it('lists mismatches first, so truncation cannot hide one', () => {
    const late = {
      ...item('new', 'mismatch'),
      finding: { ...item('new', 'mismatch').finding, key: 'zksync:0xlast' },
    }
    const text =
      renderSlackAlert(
        [...Array.from({ length: 5 }, () => item('new', 'unverified')), late],
        undefined
      ) ?? ''
    const [, first] = text.split('\n')
    expect(first).toContain('zksync:0xlast')
  })

  it('splits into posts inside the Slack budget, dropping no alert', () => {
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...item('new', 'mismatch'),
      finding: { ...item('new', 'mismatch').finding, key: `base:0x${i}` },
    }))
    const posts = renderSlackPosts(many, 'https://example.test/run')
    expect(posts.length).toBeGreaterThan(1)
    for (const post of posts)
      expect(post.length).toBeLessThanOrEqual(SLACK_TEXT_BUDGET)
    const all = posts.join('\n')
    for (let i = 0; i < 200; i++) expect(all).toContain(`base:0x${i}:`)
  })
})
