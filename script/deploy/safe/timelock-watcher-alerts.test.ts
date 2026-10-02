/**
 * Tests for the timelock watcher's alert dedupe. Each alert case is paired
 * with the case one step short of it, which must stay quiet.
 */
import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  DIGEST_INTERVAL_MS,
  MISMATCH_REALERT_MS,
  UNVERIFIED_PAGE_AFTER_RUNS,
  UNVERIFIED_REALERT_MS,
  decideAlerts,
  findingKey,
  planDelivery,
  reasonsSignature,
  type IAlertItem,
  type IAlertRecord,
  type IDeliveryState,
  type IWatchFinding,
} from './timelock-watcher-alerts'
import type { TWatcherVerdict } from './timelock-watcher-verdict'

const NOW = new Date('2026-09-29T00:00:00.000Z')
const OP = '0xabc'
const KEY = findingKey('base', OP)
const ALL = new Set(['base'])

const finding = (
  verdict: TWatcherVerdict,
  key = KEY,
  network = 'base'
): IWatchFinding => ({ key, network, verdict, reasons: [`${verdict} reason`] })

const recordAt = (
  verdict: IAlertRecord['verdict'],
  msAgo: number
): IAlertRecord => ({
  verdict,
  alertedAt: new Date(NOW.getTime() - msAgo).toISOString(),
  reasons: reasonsSignature(verdict, [`${verdict} reason`]),
})

describe('findingKey', () => {
  it('lowercases both halves', () => {
    expect(findingKey('Base', '0xABC')).toBe('base:0xabc')
  })
})

describe('decideAlerts: first sight', () => {
  it('alerts a new mismatch and records it', () => {
    const decision = decideAlerts({}, [finding('mismatch')], ALL, NOW)
    expect(decision.alerts.map((a) => a.kind)).toEqual(['new'])
    expect(decision.next[KEY]).toEqual({
      verdict: 'mismatch',
      alertedAt: NOW.toISOString(),
      reasons: 'mismatch reason',
    })
  })

  it('alerts a new unverified finding', () => {
    const decision = decideAlerts({}, [finding('unverified')], ALL, NOW)
    expect(decision.alerts.map((a) => a.kind)).toEqual(['new'])
  })

  it('stays quiet about a new ok finding and records nothing', () => {
    const decision = decideAlerts({}, [finding('ok')], ALL, NOW)
    expect(decision.alerts).toEqual([])
    expect(decision.next).toEqual({})
  })
})

describe('reasonsSignature', () => {
  const MISSED =
    'queued operation 0xabc is pending on chain but the log scan did not find it'

  it('keys a mismatch on the checks that fail, not their detail', () => {
    expect(reasonsSignature('mismatch', ['authority: call 0 grants X'])).toBe(
      reasonsSignature('mismatch', ['authority: another detail'])
    )
    expect(reasonsSignature('mismatch', ['authority: x'])).not.toBe(
      reasonsSignature('mismatch', ['authority: x', 'targets: y'])
    )
  })

  it('ignores unknown checks and read errors, which flap with node health', () => {
    expect(
      reasonsSignature('unverified', [
        'codehash: queued behind this run',
        'authorities: fetch failed',
      ])
    ).toBe(reasonsSignature('unverified', ['codehash: queued behind this run']))
    expect(
      reasonsSignature('unverified', [
        'history before block 100 is not scanned yet',
        'no endpoint would serve the next history range: HTTP 502',
      ])
    ).toBe(reasonsSignature('unverified', []))
  })

  it('keys a mismatched network on its notes, without their detail', () => {
    const minDelay = 'getMinDelay() is 60, below the agreed 10800'
    const owner = 'LiFiDiamond.owner() is 0xdead, not the timelock'
    expect(reasonsSignature('mismatch', [minDelay])).toBe(
      reasonsSignature('mismatch', [
        'getMinDelay() is 30, below the agreed 10800',
      ])
    )
    expect(reasonsSignature('mismatch', [minDelay])).not.toBe(
      reasonsSignature('mismatch', [minDelay, owner])
    )
    expect(reasonsSignature('unverified', [minDelay, owner])).toBe('')
  })

  it('tells an operation the log scan missed apart', () => {
    expect(
      reasonsSignature('unverified', [
        'history before block 100 is not scanned yet',
      ])
    ).not.toBe(
      reasonsSignature('unverified', [
        'history before block 100 is not scanned yet',
        MISSED,
      ])
    )
  })
})

describe('decideAlerts: standing findings', () => {
  it('pages a check that starts failing once, not each time it flaps', () => {
    const at = (reasons: string[]): IWatchFinding => ({
      ...finding('mismatch'),
      reasons,
    })
    const one = ['authority: whitelists x']
    const two = ['authority: whitelists x', 'authorities: owner drift']
    let records: Record<string, IAlertRecord> = {
      [KEY]: { ...recordAt('mismatch', 1), reasons: 'authority' },
    }
    const kinds: string[][] = []
    for (const reasons of [two, one, two, one]) {
      const decision = decideAlerts(records, [at(reasons)], ALL, NOW)
      kinds.push(decision.alerts.map((alert) => alert.kind))
      records = decision.next
    }
    expect(kinds).toEqual([['changed'], [], [], []])
  })

  it('leads a changed alert with the reason that is new', () => {
    const decision = decideAlerts(
      { [KEY]: { ...recordAt('mismatch', 1), reasons: 'authority' } },
      [
        {
          ...finding('mismatch'),
          reasons: ['authority: whitelists x', 'codehash: matches none'],
        },
      ],
      ALL,
      NOW
    )
    expect(decision.alerts[0]?.finding.reasons[0]).toBe(
      'codehash: matches none'
    )
  })

  it('alerts a new reason under a standing verdict inside its throttle', () => {
    const standing = recordAt('unverified', 1)
    const decision = decideAlerts(
      { [KEY]: standing },
      [
        {
          ...finding('unverified'),
          reasons: [
            'unverified reason',
            'queued operation 0xdef is pending on chain but the log scan did not find it',
          ],
        },
      ],
      ALL,
      NOW
    )
    expect(decision.alerts.map((a) => a.kind)).toEqual(['changed'])
    expect(decision.next[KEY]?.alertedAt).toBe(standing.alertedAt)
  })

  it('counts a new reason on a run the repeat is due as the repeat', () => {
    const due = { ...recordAt('mismatch', MISMATCH_REALERT_MS), reasons: '' }
    const first = decideAlerts(
      { [KEY]: due },
      [{ ...finding('mismatch'), reasons: ['codehash: matches none'] }],
      ALL,
      NOW
    )
    expect(first.alerts.map((alert) => alert.kind)).toEqual(['changed'])
    expect(first.next[KEY]?.alertedAt).toBe(NOW.toISOString())
  })

  it('pages two notes that take turns on a mismatched network once each', () => {
    const at = (notes: string[]): IWatchFinding => ({
      key: findingKey('base', 'network'),
      network: 'base',
      verdict: 'mismatch',
      reasons: ['LiFiDiamond.owner() is 0xdead, not the timelock', ...notes],
    })
    const delay = 'getMinDelay() could not be read: timeout'
    const queue = 'the execution queue could not be read for a cross-check: x'
    let records: Record<string, IAlertRecord> = {}
    const kinds: string[][] = []
    for (const notes of [[], [delay], [queue], [delay], [queue]]) {
      const decision = decideAlerts(records, [at(notes)], ALL, NOW)
      kinds.push(decision.alerts.map((alert) => alert.kind))
      records = decision.next
    }
    expect(kinds).toEqual([['new'], ['changed'], ['changed'], [], []])
  })

  it('adopts the reasons of a record written before they were kept, quietly', () => {
    const { reasons: _, ...legacy } = recordAt('mismatch', 1)
    const decision = decideAlerts(
      { [KEY]: legacy },
      [finding('mismatch')],
      ALL,
      NOW
    )
    expect(decision.alerts).toEqual([])
    expect(decision.next[KEY]).toEqual({
      ...legacy,
      reasons: 'mismatch reason',
    })
  })

  it('suppresses a standing mismatch inside its throttle', () => {
    const standing = recordAt('mismatch', MISMATCH_REALERT_MS - 1)
    const decision = decideAlerts(
      { [KEY]: standing },
      [finding('mismatch')],
      ALL,
      NOW
    )
    expect(decision.alerts).toEqual([])
    expect(decision.next[KEY]).toEqual(standing)
  })

  it('re-alerts a standing mismatch once its throttle elapsed', () => {
    const previous = { [KEY]: recordAt('mismatch', MISMATCH_REALERT_MS) }
    const decision = decideAlerts(previous, [finding('mismatch')], ALL, NOW)
    expect(decision.alerts.map((a) => a.kind)).toEqual(['repeat'])
    expect(decision.next[KEY]?.alertedAt).toBe(NOW.toISOString())
  })

  it('throttles unverified on its own, longer interval', () => {
    const inside = { [KEY]: recordAt('unverified', MISMATCH_REALERT_MS) }
    expect(
      decideAlerts(inside, [finding('unverified')], ALL, NOW).alerts
    ).toEqual([])
    const elapsed = { [KEY]: recordAt('unverified', UNVERIFIED_REALERT_MS) }
    expect(
      decideAlerts(elapsed, [finding('unverified')], ALL, NOW).alerts.map(
        (a) => a.kind
      )
    ).toEqual(['repeat'])
  })

  it('treats an unparseable stamp as elapsed, not as fresh', () => {
    const previous = {
      [KEY]: { verdict: 'mismatch' as const, alertedAt: 'not a date' },
    }
    expect(
      decideAlerts(previous, [finding('mismatch')], ALL, NOW).alerts.map(
        (a) => a.kind
      )
    ).toEqual(['repeat'])
  })

  it('treats a stamp in the future as inside the throttle', () => {
    const previous = { [KEY]: recordAt('mismatch', -1000) }
    expect(
      decideAlerts(previous, [finding('mismatch')], ALL, NOW).alerts
    ).toEqual([])
  })
})

describe('decideAlerts: changes of verdict', () => {
  it('alerts at once when unverified becomes mismatch, inside any throttle', () => {
    const previous = { [KEY]: recordAt('unverified', 0) }
    const decision = decideAlerts(previous, [finding('mismatch')], ALL, NOW)
    expect(decision.alerts).toEqual([
      { finding: finding('mismatch'), kind: 'changed', previous: 'unverified' },
    ])
    expect(decision.next[KEY]?.verdict).toBe('mismatch')
  })

  it('alerts the return to ok once, and drops the record when its throttle ends', () => {
    const previous = { [KEY]: recordAt('mismatch', 0) }
    const decision = decideAlerts(previous, [finding('ok')], ALL, NOW)
    expect(decision.alerts.map((a) => a.kind)).toEqual(['resolved'])
    expect(decision.next[KEY]?.resolvedAt).toBe(NOW.toISOString())
    expect(
      decideAlerts(decision.next, [finding('ok')], ALL, NOW).alerts
    ).toEqual([])
    const later = new Date(NOW.getTime() + MISMATCH_REALERT_MS)
    expect(
      decideAlerts(decision.next, [finding('ok')], ALL, later).next[KEY]
    ).toBeUndefined()
  })

  it('announces an unverified finding that flaps with node health once, not on every flip', () => {
    let records: Record<string, IAlertRecord> = {}
    const kinds: string[][] = []
    for (const verdict of [
      'unverified',
      'ok',
      'unverified',
      'ok',
      'unverified',
    ] as const) {
      const decision = decideAlerts(records, [finding(verdict)], ALL, NOW)
      kinds.push(decision.alerts.map((alert) => alert.kind))
      records = decision.next
    }
    expect(kinds).toEqual([['new'], ['resolved'], [], [], []])
  })

  it('announces the return to ok of a finding that came back with a new reason', () => {
    const missed =
      'queued operation 0xdef is pending on chain but the log scan did not find it'
    let records: Record<string, IAlertRecord> = {}
    const kinds: string[][] = []
    for (const f of [
      finding('unverified'),
      finding('ok'),
      { ...finding('unverified'), reasons: [missed] },
      finding('ok'),
    ]) {
      const decision = decideAlerts(records, [f], ALL, NOW)
      kinds.push(decision.alerts.map((alert) => alert.kind))
      records = decision.next
    }
    expect(kinds).toEqual([['new'], ['resolved'], ['changed'], ['resolved']])
  })

  it('alerts a mismatch that comes back after it resolved', () => {
    const resolved = {
      [KEY]: { ...recordAt('mismatch', 1), resolvedAt: NOW.toISOString() },
    }
    expect(
      decideAlerts(resolved, [finding('mismatch')], ALL, NOW).alerts.map(
        (a) => a.kind
      )
    ).toEqual(['new'])
  })
})

describe('decideAlerts: subjects that disappear', () => {
  const OTHER = findingKey('mainnet', '0xdef')

  it('announces and drops an operation a completely read network no longer reports', () => {
    const previous = { [KEY]: recordAt('mismatch', 0) }
    const decision = decideAlerts(previous, [], ALL, NOW)
    expect(decision.next[KEY]).toBeUndefined()
    expect(
      decision.alerts.map((a) => [a.kind, a.finding.key, a.previous])
    ).toEqual([['resolved', KEY, 'mismatch']])
  })

  it('drops a network record quietly: the network finding itself reports its state', () => {
    const NETWORK = findingKey('base', 'network')
    const decision = decideAlerts(
      { [NETWORK]: recordAt('unverified', 0) },
      [],
      ALL,
      NOW
    )
    expect(decision.alerts).toEqual([])
    expect(decision.next[NETWORK]).toBeUndefined()
  })

  it('keeps the record for a network that could not be read', () => {
    const other = recordAt('unverified', 0)
    const previous = { [KEY]: recordAt('mismatch', 0), [OTHER]: other }
    const decision = decideAlerts(previous, [], ALL, NOW)
    expect(decision.next[OTHER]).toEqual(other)
    expect(decision.next[KEY]).toBeUndefined()
  })

  it('does not re-page a subject whose network came back unchanged', () => {
    const previous = { [OTHER]: recordAt('mismatch', 0) }
    const kept = decideAlerts(previous, [], ALL, NOW).next
    const back = decideAlerts(
      kept,
      [finding('mismatch', OTHER, 'mainnet')],
      new Set(['base', 'mainnet']),
      NOW
    )
    expect(back.alerts).toEqual([])
  })
})

describe('planDelivery', () => {
  const fresh = (): IDeliveryState => ({ streaks: {}, held: [] })
  const plan = (
    previous: Record<string, IAlertRecord>,
    findings: IWatchFinding[],
    delivery = fresh(),
    now = NOW,
    settled = ALL
  ) =>
    planDelivery(
      previous,
      decideAlerts(previous, findings, settled, now),
      delivery,
      now
    )
  const resolvedItem = (key = KEY): IAlertItem => ({
    kind: 'resolved',
    previous: 'unverified',
    finding: { key, network: 'base', verdict: 'ok', reasons: [] },
  })

  it('pages a new mismatch at once', () => {
    const result = plan({}, [finding('mismatch')])
    expect(result.actionable.map((a) => a.kind)).toEqual(['new'])
    expect(result.next[KEY]?.verdict).toBe('mismatch')
    expect(result.delivered.lastPostAt).toBe(NOW.toISOString())
  })

  it('holds a new unverified finding back until it has lasted the threshold, recording nothing', () => {
    let delivery = fresh()
    for (let run = 1; run < UNVERIFIED_PAGE_AFTER_RUNS; run++) {
      const result = plan({}, [finding('unverified')], delivery)
      expect(result.actionable).toEqual([])
      expect(result.next).toEqual({})
      expect(result.delivered.streaks[KEY]).toBe(run)
      delivery = result.delivered
    }
    const paged = plan({}, [finding('unverified')], delivery)
    expect(paged.actionable.map((a) => a.kind)).toEqual(['new'])
    expect(paged.next[KEY]?.verdict).toBe('unverified')
  })

  it('restarts the count when the finding clears between runs', () => {
    const first = plan({}, [finding('unverified')])
    const cleared = plan({}, [finding('ok')], first.delivered)
    expect(cleared.delivered.streaks).toEqual({})
    const again = plan({}, [finding('unverified')], cleared.delivered)
    expect(again.actionable).toEqual([])
    expect(again.delivered.streaks[KEY]).toBe(1)
  })

  it('keeps the count when the page could not be delivered, so the next run re-sends it', () => {
    const delivery = {
      streaks: { [KEY]: UNVERIFIED_PAGE_AFTER_RUNS - 1 },
      held: [],
    }
    const failed = plan({}, [finding('unverified')], delivery)
    expect(failed.actionable).toHaveLength(1)
    const retry = plan({}, [finding('unverified')], failed.undelivered)
    expect(retry.actionable).toHaveLength(1)
  })

  it('keeps the old resolved record of a held-back finding', () => {
    const old = {
      ...recordAt('unverified', UNVERIFIED_REALERT_MS + 1),
      resolvedAt: NOW.toISOString(),
    }
    const result = plan({ [KEY]: old }, [finding('unverified')])
    expect(result.actionable).toEqual([])
    expect(result.next[KEY]).toEqual(old)
  })

  it('holds a resolution instead of posting it', () => {
    const result = plan(
      { [KEY]: recordAt('unverified', 60_000) },
      [finding('ok')],
      { streaks: {}, held: [], lastPostAt: NOW.toISOString() }
    )
    expect(result.actionable).toEqual([])
    expect(result.digest).toEqual([])
    expect(result.delivered.held.map((a) => a.kind)).toEqual(['resolved'])
    expect(result.next[KEY]?.resolvedAt).toBe(NOW.toISOString())
  })

  it('holds a standing unverified repeat', () => {
    const result = plan(
      { [KEY]: recordAt('unverified', UNVERIFIED_REALERT_MS) },
      [finding('unverified')],
      { streaks: {}, held: [], lastPostAt: NOW.toISOString() }
    )
    expect(result.actionable).toEqual([])
    expect(result.delivered.held.map((a) => a.kind)).toEqual(['repeat'])
  })

  it('holds a mismatch stepping down to unverified', () => {
    const result = plan(
      { [KEY]: recordAt('mismatch', 60_000) },
      [finding('unverified')],
      { streaks: {}, held: [], lastPostAt: NOW.toISOString() }
    )
    expect(result.actionable).toEqual([])
    expect(result.delivered.held[0]?.previous).toBe('mismatch')
  })

  it('pages a new note under a standing unverified verdict', () => {
    const scanMiss =
      'queue: 0x1 is pending on chain but the log scan did not find it'
    const result = plan({ [KEY]: recordAt('unverified', 60_000) }, [
      { ...finding('unverified'), reasons: [scanMiss] },
    ])
    expect(result.actionable.map((a) => a.kind)).toEqual(['changed'])
  })

  it('pages a standing mismatch repeat', () => {
    const result = plan({ [KEY]: recordAt('mismatch', MISMATCH_REALERT_MS) }, [
      finding('mismatch'),
    ])
    expect(result.actionable.map((a) => a.kind)).toEqual(['repeat'])
  })

  it('sends held updates with the next page and clears them', () => {
    const other = findingKey('base', '0xdef')
    const result = plan({}, [finding('mismatch', other)], {
      streaks: {},
      held: [resolvedItem()],
      lastPostAt: NOW.toISOString(),
    })
    expect(result.digest.map((a) => a.finding.key)).toEqual([KEY])
    expect(result.delivered.held).toEqual([])
    expect(result.undelivered.held.map((a) => a.finding.key)).toEqual([KEY])
  })

  it('posts a digest once the interval since the last post has passed', () => {
    const lastPostAt = (msAgo: number): string =>
      new Date(NOW.getTime() - msAgo).toISOString()
    const early = plan({}, [], {
      streaks: {},
      held: [resolvedItem()],
      lastPostAt: lastPostAt(DIGEST_INTERVAL_MS - 1),
    })
    expect(early.digest).toEqual([])
    expect(early.delivered.held).toHaveLength(1)
    const due = plan({}, [], {
      streaks: {},
      held: [resolvedItem()],
      lastPostAt: lastPostAt(DIGEST_INTERVAL_MS),
    })
    expect(due.actionable).toEqual([])
    expect(due.digest).toHaveLength(1)
    expect(due.delivered).toEqual({
      streaks: {},
      held: [],
      lastPostAt: NOW.toISOString(),
    })
  })

  it('posts nothing and starts the digest clock when nothing is held', () => {
    const result = plan({}, [])
    expect(result.actionable).toEqual([])
    expect(result.digest).toEqual([])
    expect(result.delivered).toEqual({
      streaks: {},
      held: [],
      lastPostAt: NOW.toISOString(),
    })
  })

  it('keeps one held update per subject, the newest', () => {
    const result = plan(
      { [KEY]: recordAt('unverified', UNVERIFIED_REALERT_MS) },
      [finding('unverified')],
      {
        streaks: {},
        held: [resolvedItem()],
        lastPostAt: NOW.toISOString(),
      }
    )
    expect(result.delivered.held.map((a) => a.kind)).toEqual(['repeat'])
  })
})
