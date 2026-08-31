/**
 * Tests for the cron-liveness watchdog's pure logic (cronLiveness.ts).
 *
 * The watchdog answers one question per scheduled workflow: has it RUN recently
 * enough, given how often its cron says it should. Everything here is pure — cron
 * classification, the grace-window formula, YAML scraping and the verdict function
 * all take plain values, so the whole decision layer is exercised without touching
 * the GitHub API, the filesystem or Slack.
 *
 * The classifier is deliberately coarse (buckets, not a full cron parser): the
 * question is "is this obviously stale", never "is this three minutes late". Its
 * one hard requirement is that it must never silently drop a workflow it cannot
 * understand — silent under-coverage is the exact failure the watchdog exists to
 * prevent — so an unparseable expression is a reported verdict, not a skip.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  classifyCron,
  composeSlackMessage,
  evaluateLiveness,
  extractCronExpressions,
  findIgnoreMarker,
  graceWindowMs,
  isAlertable,
} from './cronLiveness'
import type { ILivenessVerdict, IWorkflowFacts } from './cronLiveness'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('classifyCron', () => {
  it('classifies a daily cron from a fixed hour', () => {
    // healthCheckAllNetworks.yml
    expect(classifyCron('23 6 * * *')).toEqual({
      kind: 'daily',
      intervalMs: DAY,
    })
  })

  it('classifies a midnight daily cron', () => {
    // networkRpcsChecker.yml — hour 0 is falsy, so a truthiness check here regresses
    expect(classifyCron('0 0 * * *')).toEqual({
      kind: 'daily',
      intervalMs: DAY,
    })
  })

  it('classifies a step-minute cron by its step', () => {
    // runPendingTimelockTXs.yml
    expect(classifyCron('*/10 * * * *')).toEqual({
      kind: 'minutely',
      intervalMs: 10 * MINUTE,
    })
  })

  it('classifies a day-of-week cron as weekly', () => {
    // reconcileParkedTasks.yml
    expect(classifyCron('17 8 * * 1')).toEqual({
      kind: 'weekly',
      intervalMs: 7 * DAY,
    })
  })

  it('classifies a day-of-month cron as monthly', () => {
    // ticketLinkageMetric.yml
    expect(classifyCron('0 9 1 * *')).toEqual({
      kind: 'monthly',
      intervalMs: 31 * DAY,
    })
  })

  it('classifies an hourly cron', () => {
    expect(classifyCron('30 * * * *')).toEqual({
      kind: 'hourly',
      intervalMs: HOUR,
    })
  })

  it('treats a day-of-month cron as monthly even when a weekday is also set', () => {
    // Real cron ORs dom and dow; the longer bucket is the safe (less alerty) read.
    expect(classifyCron('0 9 1 * 3')).toEqual({
      kind: 'monthly',
      intervalMs: 31 * DAY,
    })
  })

  it('reports an expression with the wrong field count rather than skipping it', () => {
    const result = classifyCron('0 9 1 *')
    expect(result.kind).toBe('unclassifiable')
  })

  it('reports a non-numeric expression rather than skipping it', () => {
    const result = classifyCron('@daily')
    expect(result.kind).toBe('unclassifiable')
  })

  it('reports a step syntax it cannot bucket rather than guessing', () => {
    // Step-hours are not a bucket we model; guessing would under-alert silently.
    const result = classifyCron('0 */6 * * *')
    expect(result.kind).toBe('unclassifiable')
  })

  it('carries a human-readable reason on every unclassifiable verdict', () => {
    const result = classifyCron('nonsense')
    if (result.kind !== 'unclassifiable')
      throw new Error('expected unclassifiable')

    expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe('graceWindowMs', () => {
  it('gives a daily cron over a day of slack on top of its interval', () => {
    // GitHub's scheduler drifts hours under load (observed 3h+ on a daily cron),
    // so one late run must never alert; two missed cycles must.
    const grace = graceWindowMs({ kind: 'daily', intervalMs: DAY })
    expect(grace).toBeGreaterThan(DAY + 6 * HOUR)
    expect(grace).toBeLessThan(2 * DAY)
  })

  it('scales the window with the interval', () => {
    const daily = graceWindowMs({ kind: 'daily', intervalMs: DAY })
    const weekly = graceWindowMs({ kind: 'weekly', intervalMs: 7 * DAY })
    expect(weekly).toBeGreaterThan(daily)
  })

  it('keeps a high-frequency cron tolerant of scheduler drift', () => {
    // A */10 cron must not alert over a single skipped tick.
    const grace = graceWindowMs({ kind: 'minutely', intervalMs: 10 * MINUTE })
    expect(grace).toBeGreaterThan(HOUR)
  })
})

describe('extractCronExpressions', () => {
  it('pulls every cron out of an on.schedule block', () => {
    const yaml = [
      'name: Example',
      'on:',
      '  schedule:',
      "    - cron: '23 6 * * *' # daily",
      "    - cron: '0 0 * * 1'",
      '  workflow_dispatch:',
      'jobs: {}',
    ].join('\n')

    expect(extractCronExpressions(yaml)).toEqual(['23 6 * * *', '0 0 * * 1'])
  })

  it('returns nothing for a workflow with no schedule', () => {
    const yaml = [
      'name: Example',
      'on:',
      '  push:',
      '    branches: [main]',
    ].join('\n')

    expect(extractCronExpressions(yaml)).toEqual([])
  })

  it('accepts double-quoted and unquoted cron values', () => {
    const yaml = [
      'on:',
      '  schedule:',
      '    - cron: "5 4 * * *"',
      '    - cron: 15 4 * * *',
    ].join('\n')

    expect(extractCronExpressions(yaml)).toEqual(['5 4 * * *', '15 4 * * *'])
  })

  it('ignores a cron that only appears inside a comment', () => {
    const yaml = [
      '# was: - cron: 0 0 * * * (retired)',
      'on:',
      '  schedule:',
      "    - cron: '23 6 * * *'",
    ].join('\n')

    expect(extractCronExpressions(yaml)).toEqual(['23 6 * * *'])
  })
})

describe('findIgnoreMarker', () => {
  it('detects an opt-out marker and captures its reason', () => {
    const yaml = [
      '# watchdog:ignore fires only during release weeks',
      'name: Example',
    ].join('\n')

    expect(findIgnoreMarker(yaml)).toEqual({
      ignored: true,
      reason: 'fires only during release weeks',
    })
  })

  it('reports no marker when absent', () => {
    expect(findIgnoreMarker('name: Example')).toEqual({ ignored: false })
  })

  it('requires a reason so an opt-out is never unexplained', () => {
    expect(findIgnoreMarker('# watchdog:ignore\nname: Example')).toEqual({
      ignored: false,
    })
  })
})

describe('classifyCron — periods longer than the buckets', () => {
  it('refuses to bucket a yearly cron as monthly', () => {
    // '0 9 1 1 *' fires once a YEAR. Bucketing it monthly would give a ~47d grace
    // window and alert every year from February onwards.
    const result = classifyCron('0 9 1 1 *')
    expect(result.kind).toBe('unclassifiable')
  })
})

describe('evaluateLiveness', () => {
  const NOW = new Date('2026-08-31T12:00:00Z')

  const dailyWorkflow = (
    overrides: Partial<IWorkflowFacts> = {}
  ): IWorkflowFacts => ({
    name: 'Diamond Health Check',
    path: '.github/workflows/healthCheckAllNetworks.yml',
    state: 'active',
    cronExpressions: ['23 6 * * *'],
    ignore: { ignored: false },
    lastScheduledRunAt: new Date('2026-08-31T06:40:00Z'),
    fileFirstSeenAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  })

  it('calls a cron that ran within its window alive', () => {
    expect(evaluateLiveness(dailyWorkflow(), NOW).status).toBe('alive')
  })

  it('tolerates a single late run', () => {
    // 30h since the last run: one skipped cycle plus drift, not yet actionable.
    const verdict = evaluateLiveness(
      dailyWorkflow({ lastScheduledRunAt: new Date('2026-08-30T06:00:00Z') }),
      NOW
    )
    expect(verdict.status).toBe('alive')
  })

  it('calls a cron that missed two cycles stale', () => {
    const verdict = evaluateLiveness(
      dailyWorkflow({ lastScheduledRunAt: new Date('2026-08-28T06:00:00Z') }),
      NOW
    )
    expect(verdict.status).toBe('stale')
  })

  it('reports a disabled workflow as disabled, not merely stale', () => {
    // Both are true; only "disabled" tells you what to actually do about it.
    const verdict = evaluateLiveness(
      dailyWorkflow({
        state: 'disabled_inactivity',
        lastScheduledRunAt: new Date('2026-01-02T06:00:00Z'),
      }),
      NOW
    )
    expect(verdict.status).toBe('disabled')
    expect(verdict.detail).toContain('disabled_inactivity')
  })

  it('honours an opt-out marker ahead of every other check', () => {
    const verdict = evaluateLiveness(
      dailyWorkflow({
        ignore: { ignored: true, reason: 'paused for Q3' },
        lastScheduledRunAt: null,
      }),
      NOW
    )
    expect(verdict.status).toBe('ignored')
    expect(verdict.detail).toContain('paused for Q3')
  })

  it('does not alert on a freshly merged cron that has not fired yet', () => {
    const verdict = evaluateLiveness(
      dailyWorkflow({
        lastScheduledRunAt: null,
        fileFirstSeenAt: new Date('2026-08-31T09:00:00Z'),
      }),
      NOW
    )
    expect(verdict.status).toBe('pending-first-run')
  })

  it('alerts on a cron that has never fired long after it was merged', () => {
    const verdict = evaluateLiveness(
      dailyWorkflow({
        lastScheduledRunAt: null,
        fileFirstSeenAt: new Date('2026-08-01T09:00:00Z'),
      }),
      NOW
    )
    expect(verdict.status).toBe('stale')
  })

  it('reports a cron it cannot classify instead of passing it as alive', () => {
    const verdict = evaluateLiveness(
      dailyWorkflow({ cronExpressions: ['0 */6 * * *'] }),
      NOW
    )
    expect(verdict.status).toBe('unclassifiable')
  })

  it('governs a multi-cron workflow by its most frequent schedule', () => {
    // Hourly + weekly: 30h of silence is fine for the weekly one but long dead
    // for the hourly one, so the tighter window must win.
    const verdict = evaluateLiveness(
      dailyWorkflow({
        cronExpressions: ['0 * * * *', '17 8 * * 1'],
        lastScheduledRunAt: new Date('2026-08-30T06:00:00Z'),
      }),
      NOW
    )
    expect(verdict.status).toBe('stale')
  })

  it('reports a workflow with no cron at all instead of silently passing it', () => {
    // Math.min() over an empty list is Infinity, which would make an unwatched
    // workflow look permanently alive — the exact silent under-coverage the
    // watchdog exists to prevent.
    const verdict = evaluateLiveness(
      dailyWorkflow({ cronExpressions: [], lastScheduledRunAt: null }),
      NOW
    )
    expect(verdict.status).toBe('unclassifiable')
  })

  it('treats only stale, disabled and unclassifiable as worth alerting', () => {
    expect(isAlertable('stale')).toBe(true)
    expect(isAlertable('disabled')).toBe(true)
    expect(isAlertable('unclassifiable')).toBe(true)
    expect(isAlertable('alive')).toBe(false)
    expect(isAlertable('ignored')).toBe(false)
    expect(isAlertable('pending-first-run')).toBe(false)
  })
})

describe('composeSlackMessage', () => {
  const verdict = (
    overrides: Partial<ILivenessVerdict> = {}
  ): ILivenessVerdict => ({
    name: 'Diamond Health Check',
    path: '.github/workflows/healthCheckAllNetworks.yml',
    status: 'alive',
    detail: 'last daily run 5.3h ago',
    ...overrides,
  })

  const RUN_URL = 'https://github.com/lifinance/contracts/actions/runs/1'

  it('stays silent when everything is healthy and no heartbeat is due', () => {
    const message = composeSlackMessage([verdict()], {
      heartbeat: false,
      runUrl: RUN_URL,
    })
    expect(message).toBeNull()
  })

  it('posts a heartbeat when one is due even though nothing is wrong', () => {
    const message = composeSlackMessage([verdict()], {
      heartbeat: true,
      runUrl: RUN_URL,
    })
    if (message === null) throw new Error('expected a heartbeat message')

    expect(message).toContain('1/1')
    expect(message).toContain(':white_check_mark:')
  })

  it('alerts on a stale cron regardless of the heartbeat schedule', () => {
    const message = composeSlackMessage(
      [verdict({ status: 'stale', detail: 'last daily run 50.0h ago' })],
      { heartbeat: false, runUrl: RUN_URL }
    )
    if (message === null) throw new Error('expected an alert')

    expect(message).toContain(':rotating_light:')
    expect(message).toContain('Diamond Health Check')
    expect(message).toContain('50.0h')
  })

  it('names every affected workflow rather than only counting them', () => {
    const message = composeSlackMessage(
      [
        verdict({ status: 'stale', name: 'Alpha' }),
        verdict({ status: 'disabled', name: 'Beta' }),
      ],
      { heartbeat: false, runUrl: RUN_URL }
    )
    if (message === null) throw new Error('expected an alert')

    expect(message).toContain('Alpha')
    expect(message).toContain('Beta')
  })

  it('always links back to the run that produced it', () => {
    const message = composeSlackMessage([verdict({ status: 'stale' })], {
      heartbeat: false,
      runUrl: RUN_URL,
    })
    expect(message).toContain(RUN_URL)
  })

  it('excludes opted-out workflows from the healthy count', () => {
    // Counting an opted-out workflow as "alive" would overstate coverage.
    const message = composeSlackMessage(
      [verdict(), verdict({ status: 'ignored', name: 'Beta' })],
      { heartbeat: true, runUrl: RUN_URL }
    )
    if (message === null) throw new Error('expected a heartbeat message')

    expect(message).toContain('1/1')
    expect(message).toContain('1 opted out')
  })
})
