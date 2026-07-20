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
  formatTtlAlertMessage,
  reconcileDecision,
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
