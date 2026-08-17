/**
 * Tests for the deferred diamond-cleanup reconcile job (reconcile-parked-tasks.ts).
 *
 * The two pure decisions are exercised directly: {@link reconcileDecision} maps a
 * task's status + on-chain/proposal truth to a lifecycle transition, and
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
  formatReconcileFailureMessage,
  formatReopenAlertMessage,
  formatTtlAlertMessage,
  reconcileDecision,
  resolveFacetPresence,
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

  it('reopens an executed task whose facet is still routed (removal never landed)', () => {
    expect(
      reconcileDecision(
        { status: 'executed' },
        { facetPresentOnChain: true, proposalStatus: 'executed' }
      )
    ).toBe('reopen')
  })

  it('reopens a superseded task whose facet is still routed', () => {
    expect(
      reconcileDecision({ status: 'superseded' }, { facetPresentOnChain: true })
    ).toBe('reopen')
  })

  it('keeps an executed task whose facet really is gone', () => {
    expect(
      reconcileDecision(
        { status: 'executed' },
        { facetPresentOnChain: false, proposalStatus: 'executed' }
      )
    ).toBe('keep')
  })

  it('keeps a superseded task whose facet really is gone', () => {
    expect(
      reconcileDecision(
        { status: 'superseded' },
        { facetPresentOnChain: false }
      )
    ).toBe('keep')
  })

  it('never revisits a cancelled task, present or not', () => {
    expect(
      reconcileDecision({ status: 'cancelled' }, { facetPresentOnChain: true })
    ).toBe('keep')
    expect(
      reconcileDecision({ status: 'cancelled' }, { facetPresentOnChain: false })
    ).toBe('keep')
  })
})

describe('resolveFacetPresence', () => {
  const task = { facetName: 'AcrossFacetV3', facetAddress: addr(0xabc) }

  it('reports present when the facet NAME is routed, even though the stored address is not', () => {
    // The worldchain regression: the task carried lisk's AcrossFacetV3 address, so
    // an address-only check said "gone" while the named facet was still live.
    expect(
      resolveFacetPresence(
        task,
        new Set(['AcrossFacetV3']),
        new Set(['0xdead'])
      )
    ).toBe(true)
  })

  it('reports present when only the stored address is routed (deploy-log entry pruned)', () => {
    expect(
      resolveFacetPresence(
        task,
        new Set(),
        new Set([task.facetAddress.toLowerCase()])
      )
    ).toBe(true)
  })

  it('matches the stored address case-insensitively', () => {
    expect(
      resolveFacetPresence(
        { ...task, facetAddress: addr(0xabc).toUpperCase() as Address },
        new Set(),
        new Set([addr(0xabc).toLowerCase()])
      )
    ).toBe(true)
  })

  it('reports absent when neither the name nor the address is routed', () => {
    expect(
      resolveFacetPresence(task, new Set(['OtherFacet']), new Set(['0xdead']))
    ).toBe(false)
  })
})

describe('formatReopenAlertMessage', () => {
  it('returns an empty string when nothing was reopened', () => {
    expect(formatReopenAlertMessage([])).toBe('')
  })

  it('groups reopened tasks by network and names the facet, prior status and PR', () => {
    const msg = formatReopenAlertMessage([
      {
        network: 'worldchain',
        facet: 'AcrossFacetV3',
        prUrl: 'https://gh/pull/1',
        from: 'executed',
      },
      {
        network: 'lens',
        facet: 'GenericSwapFacet',
        prUrl: 'https://gh/pull/2',
        from: 'superseded',
      },
    ])
    expect(msg).toContain('2 deferred diamond-cleanup task(s)')
    expect(msg).toContain('STILL ROUTED')
    expect(msg).toContain('[worldchain]')
    expect(msg).toContain('AcrossFacetV3 (was executed) → https://gh/pull/1')
    expect(msg).toContain('[lens]')
    expect(msg).toContain(
      'GenericSwapFacet (was superseded) → https://gh/pull/2'
    )
  })
})

describe('formatReconcileFailureMessage', () => {
  it('returns an empty string when every network was reconciled', () => {
    expect(formatReconcileFailureMessage([])).toBe('')
  })

  it('names each skipped network, its environment and the reason', () => {
    const msg = formatReconcileFailureMessage([
      {
        network: 'harmony',
        environment: EnvironmentEnum.production,
        reason: 'Chain harmony does not exist',
      },
      {
        network: 'velas',
        environment: EnvironmentEnum.production,
        reason: 'no LiFiDiamond in deploy log',
      },
    ])
    expect(msg).toContain('2 network(s) could not be reconciled')
    expect(msg).toContain('NOT verified')
    expect(msg).toContain('harmony:production — Chain harmony does not exist')
    expect(msg).toContain('velas:production — no LiFiDiamond in deploy log')
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
