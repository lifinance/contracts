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
  MISMATCH_REALERT_MS,
  UNVERIFIED_REALERT_MS,
  decideAlerts,
  findingKey,
  reasonsSignature,
  type IAlertRecord,
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
  reasons: `${verdict} reason`,
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
  it('keys operation reasons on the check that did not pass', () => {
    expect(
      reasonsSignature([
        'codehash: queued behind this run',
        'authority: call 0 grants X',
      ])
    ).toBe(reasonsSignature(['authority: another detail', 'codehash: other']))
  })

  it('ignores a moving backfill cursor and error wording', () => {
    expect(
      reasonsSignature([
        'history before block 100 is not scanned yet',
        'getMinDelay() could not be read: timeout after 20000ms',
      ])
    ).toBe(
      reasonsSignature([
        'history before block 9000 is not scanned yet',
        'getMinDelay() could not be read: HTTP 502',
      ])
    )
  })

  it('tells a new note apart', () => {
    expect(
      reasonsSignature(['history before block 100 is not scanned yet'])
    ).not.toBe(
      reasonsSignature([
        'history before block 100 is not scanned yet',
        'queued operation 0xabc is pending on chain but the log scan did not find it',
      ])
    )
  })
})

describe('decideAlerts: standing findings', () => {
  it('alerts a new reason under a standing verdict inside its throttle', () => {
    const standing = recordAt('unverified', 1)
    const decision = decideAlerts(
      { [KEY]: standing },
      [
        {
          ...finding('unverified'),
          reasons: ['unverified reason', 'codehash: could not rebuild'],
        },
      ],
      ALL,
      NOW
    )
    expect(decision.alerts.map((a) => a.kind)).toEqual(['changed'])
    expect(decision.next[KEY]?.alertedAt).toBe(NOW.toISOString())
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

  it('alerts the return to ok and drops the record', () => {
    const previous = { [KEY]: recordAt('mismatch', 0) }
    const decision = decideAlerts(previous, [finding('ok')], ALL, NOW)
    expect(decision.alerts.map((a) => a.kind)).toEqual(['resolved'])
    expect(decision.next[KEY]).toBeUndefined()
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
