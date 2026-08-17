/**
 * Tests for the deferred diamond-cleanup reconcile job (reconcile-parked-tasks.ts).
 *
 * The pure decisions are exercised directly: {@link reconcileDecision} maps a task's
 * status + on-chain/proposal truth to a lifecycle transition,
 * {@link partitionByNetworkStatus} / {@link deprecatedNetworkDecision} /
 * {@link shouldCancelDeprecated} decide what happens to a task whose network is no
 * longer active (and, crucially, when a cancellation is allowed to be applied), and
 * {@link computeTtlAlerts} / {@link formatTtlAlertMessage} surface open tasks that
 * have aged past the TTL. The live CLI (Mongo/loupe/Slack wiring) is unit-test
 * exempt, mirroring the store's `getParkedTasksCollection()` carve-out.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Address } from 'viem'

import { EnvironmentEnum } from '../../common/types'

import { type IParkedTask } from './parked-tasks'
import {
  computeTtlAlerts,
  deprecatedNetworkDecision,
  formatTtlAlertMessage,
  partitionByNetworkStatus,
  parseTtlDays,
  reconcileDecision,
  shouldCancelDeprecated,
} from './reconcile-parked-tasks'

const DAY_MS = 24 * 60 * 60 * 1000
const addr = (n: number): Address =>
  `0x${n.toString(16).padStart(40, '0')}` as Address

function parked(over: Partial<IParkedTask> = {}): IParkedTask {
  return {
    taskKey: `facet-removal|arbitrum|production|${over.facetName ?? 'F'}`,
    kind: 'facet-removal',
    network: 'arbitrum',
    environment: EnvironmentEnum.production,
    facetName: 'F',
    diamondAddress: addr(0xd),
    facetAddress: addr(0xf),
    prUrl: 'https://github.com/lifinance/contracts/pull/2046',
    status: 'queued',
    enqueuer: 'dev@li.finance',
    createdAt: new Date(),
    ...over,
  }
}

describe('reconcileDecision', () => {
  it('marks a proposed task executed when the facet is gone AND its proposal executed', () => {
    expect(
      reconcileDecision(
        { status: 'proposed' },
        { facetPresentOnChain: false, proposalStatus: 'executed' }
      )
    ).toBe('executed')
  })

  it('supersedes a gone facet whose proposal did not execute (removed another way)', () => {
    expect(
      reconcileDecision(
        { status: 'proposed' },
        { facetPresentOnChain: false, proposalStatus: 'reverted' }
      )
    ).toBe('superseded')
  })

  it('supersedes a gone facet when the proposal status is unknown (loupe-only mode)', () => {
    expect(
      reconcileDecision({ status: 'proposed' }, { facetPresentOnChain: false })
    ).toBe('superseded')
  })

  it('supersedes a queued task whose facet is already gone (self-heal before drain)', () => {
    expect(
      reconcileDecision({ status: 'queued' }, { facetPresentOnChain: false })
    ).toBe('superseded')
  })

  it('reverts a proposed task to queued when its proposal reverted and the facet is still present', () => {
    expect(
      reconcileDecision(
        { status: 'proposed' },
        { facetPresentOnChain: true, proposalStatus: 'reverted' }
      )
    ).toBe('revert')
  })

  it('keeps a proposed task whose proposal is still pending', () => {
    expect(
      reconcileDecision(
        { status: 'proposed' },
        { facetPresentOnChain: true, proposalStatus: 'pending' }
      )
    ).toBe('keep')
  })

  it('keeps a queued task whose facet is still present (awaiting drain)', () => {
    expect(
      reconcileDecision({ status: 'queued' }, { facetPresentOnChain: true })
    ).toBe('keep')
  })
})

describe('deprecatedNetworkDecision', () => {
  it('cancels a queued task whose network is no longer active', () => {
    expect(deprecatedNetworkDecision({ status: 'queued' })).toBe('cancel')
  })

  it('keeps a proposed task so its live Safe proposal is not orphaned', () => {
    expect(deprecatedNetworkDecision({ status: 'proposed' })).toBe('keep')
  })
})

describe('partitionByNetworkStatus', () => {
  // Derived the way the live adapter derives it (`getAllActiveNetworks`), so the
  // present-but-inactive case is distinguishable from the absent one rather than
  // both trivially missing from a hand-written set.
  const activeIdsOf = (config: Record<string, { status: string }>) =>
    new Set(
      Object.entries(config)
        .filter(([, n]) => n.status === 'active')
        .map(([id]) => id)
    )
  const active = activeIdsOf({
    arbitrum: { status: 'active' },
    mainnet: { status: 'active' },
    localanvil: { status: 'inactive' },
  })

  it('routes a task on an active network to the reconcile path', () => {
    const task = parked({ network: 'arbitrum' })
    expect(partitionByNetworkStatus([task], active)).toEqual({
      live: [task],
      deprecated: [],
    })
  })

  it('routes a task on a network absent from networks.json to the deprecated path', () => {
    const task = parked({ network: 'harmony' })
    expect(partitionByNetworkStatus([task], active)).toEqual({
      live: [],
      deprecated: [task],
    })
  })

  it('treats a network present in the config but not active as deprecated', () => {
    const task = parked({ network: 'localanvil' })
    expect(active.has('localanvil')).toBe(false)
    expect(partitionByNetworkStatus([task], active).deprecated).toEqual([task])
  })
})

describe('shouldCancelDeprecated', () => {
  it('cancels only when the operator asked for it on a named network', () => {
    expect(
      shouldCancelDeprecated('cancel', {
        apply: true,
        cancelDeprecated: true,
        networkFilter: 'harmony',
      })
    ).toBe(true)
  })

  it('never cancels on an unattended fleet-wide run — the cron must not mass-cancel', () => {
    expect(
      shouldCancelDeprecated('cancel', {
        apply: true,
        cancelDeprecated: true,
        networkFilter: undefined,
      })
    ).toBe(false)
  })

  it('never cancels without the opt-in flag', () => {
    expect(
      shouldCancelDeprecated('cancel', {
        apply: true,
        cancelDeprecated: false,
        networkFilter: 'harmony',
      })
    ).toBe(false)
  })

  it('never cancels in a dry run', () => {
    expect(
      shouldCancelDeprecated('cancel', {
        apply: false,
        cancelDeprecated: true,
        networkFilter: 'harmony',
      })
    ).toBe(false)
  })

  it('never cancels a task the decision left alone', () => {
    expect(
      shouldCancelDeprecated('keep', {
        apply: true,
        cancelDeprecated: true,
        networkFilter: 'harmony',
      })
    ).toBe(false)
  })
})

describe('parseTtlDays', () => {
  it('accepts a positive integer', () => {
    expect(parseTtlDays('30')).toBe(30)
  })

  it('falls back to the default when the flag is absent', () => {
    expect(parseTtlDays(undefined)).toBe(60)
  })

  it('rejects a non-numeric value rather than flagging every open task', () => {
    // NaN makes `ageDays < ttlDays` false for every task, which would alert on the
    // whole fleet instead of the stale ones.
    expect(() => parseTtlDays('soon')).toThrow(/positive integer/)
  })

  it('rejects a negative value', () => {
    expect(() => parseTtlDays('-1')).toThrow(/positive integer/)
  })

  it('rejects a fractional value', () => {
    expect(() => parseTtlDays('1.5')).toThrow(/positive integer/)
  })
})

describe('computeTtlAlerts', () => {
  const now = new Date('2026-07-17T00:00:00.000Z')

  it('flags an open task older than the TTL', () => {
    const t = parked({
      facetName: 'OldOne',
      createdAt: new Date(now.getTime() - 65 * DAY_MS),
    })
    const stale = computeTtlAlerts([t], now, 60)
    expect(stale).toEqual([
      {
        network: 'arbitrum',
        facet: 'OldOne',
        prUrl: t.prUrl,
        status: 'queued',
        ageDays: 65,
      },
    ])
  })

  it('ignores an open task younger than the TTL', () => {
    const t = parked({ createdAt: new Date(now.getTime() - 10 * DAY_MS) })
    expect(computeTtlAlerts([t], now, 60)).toHaveLength(0)
  })

  it('flags a stuck proposed task too (nothing orphaned)', () => {
    const t = parked({
      status: 'proposed',
      createdAt: new Date(now.getTime() - 90 * DAY_MS),
    })
    const stale = computeTtlAlerts([t], now, 60)
    expect(stale).toHaveLength(1)
    expect(stale[0]?.status).toBe('proposed')
    expect(stale[0]?.ageDays).toBe(90)
  })

  it('never flags terminal tasks (executed/superseded/cancelled)', () => {
    const old = (status: IParkedTask['status']): IParkedTask =>
      parked({ status, createdAt: new Date(now.getTime() - 365 * DAY_MS) })
    const stale = computeTtlAlerts(
      [old('executed'), old('superseded'), old('cancelled')],
      now,
      60
    )
    expect(stale).toHaveLength(0)
  })
})

describe('formatTtlAlertMessage', () => {
  it('returns an empty string when there is nothing stale', () => {
    expect(formatTtlAlertMessage([], 60)).toBe('')
  })

  it('groups stale tasks by network and names facet, status, age and PR', () => {
    const msg = formatTtlAlertMessage(
      [
        {
          network: 'arbitrum',
          facet: 'A',
          prUrl: 'https://gh/pull/1',
          status: 'queued',
          ageDays: 65,
        },
        {
          network: 'optimism',
          facet: 'B',
          prUrl: 'https://gh/pull/2',
          status: 'proposed',
          ageDays: 70,
        },
      ],
      60
    )
    expect(msg).toContain('60')
    expect(msg).toContain('arbitrum')
    expect(msg).toContain('optimism')
    expect(msg).toContain('A')
    expect(msg).toContain('queued')
    expect(msg).toContain('65d')
    expect(msg).toContain('https://gh/pull/1')
    expect(msg).toContain('https://gh/pull/2')
  })
})
