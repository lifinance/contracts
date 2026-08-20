/**
 * Tests for the deferred diamond-cleanup reconcile job (reconcile-parked-tasks.ts).
 *
 * The two pure decisions are exercised directly: {@link reconcileDecision} maps a
 * task's status + on-chain/proposal truth to a lifecycle transition, and
 * {@link computeTtlAlerts} / {@link formatTtlAlertMessage} surface open tasks that
 * have aged past the TTL, and {@link ttlAlertDelivery} decides whether an alert is
 * posted, logged, or treated as a misconfiguration. The live CLI (Mongo/loupe/Slack
 * wiring) is unit-test exempt, mirroring the store's `getParkedTasksCollection()` carve-out.
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
  formatOrphanedTaskMessage,
  formatReconcileFailureMessage,
  formatTtlAlertMessage,
  joinAlertSections,
  partitionRetiredNetworks,
  reconcileDecision,
  ttlAlertDelivery,
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

describe('ttlAlertDelivery', () => {
  it('stays silent on a dry-run even when everything else is configured', () => {
    expect(ttlAlertDelivery(false, true, 'https://hooks.slack/x')).toBe(
      'dry-run'
    )
  })

  it('logs instead of posting on a local run, keeping rehearsals off the channel', () => {
    expect(ttlAlertDelivery(true, false, 'https://hooks.slack/x')).toBe('local')
  })

  it('posts on the applied unattended run', () => {
    expect(ttlAlertDelivery(true, true, 'https://hooks.slack/x')).toBe('send')
  })

  it.each([undefined, ''])(
    'reports a missing webhook (%p) rather than dropping the alert silently',
    (webhook) => {
      expect(ttlAlertDelivery(true, true, webhook)).toBe('misconfigured')
    }
  )

  it('does not report a misconfiguration on a local run with no webhook', () => {
    expect(ttlAlertDelivery(true, false, undefined)).toBe('local')
  })
})

describe('partitionRetiredNetworks', () => {
  const known = (n: string) => ['arbitrum', 'optimism'].includes(n)

  it('keeps tasks whose network is still configured', () => {
    const tasks = [
      parked({ network: 'arbitrum' }),
      parked({ network: 'optimism' }),
    ]
    const { reconcilable, orphaned } = partitionRetiredNetworks(tasks, known)
    expect(reconcilable).toEqual(tasks)
    expect(orphaned).toEqual([])
  })

  it('holds back a task on a retired network instead of letting it reach the loupe', () => {
    const { reconcilable, orphaned } = partitionRetiredNetworks(
      [
        parked({ network: 'harmony', facetName: 'GenericSwapFacet' }),
        parked({ network: 'arbitrum', facetName: 'AcrossFacetV3' }),
      ],
      known
    )
    expect(reconcilable.map((t) => t.network)).toEqual(['arbitrum'])
    expect(orphaned).toEqual([
      {
        network: 'harmony',
        environment: EnvironmentEnum.production,
        facet: 'GenericSwapFacet',
        status: 'queued',
        prUrl: 'https://github.com/lifinance/contracts/pull/2046',
      },
    ])
  })

  it('reports every retired network, not just the first one reached', () => {
    const { reconcilable, orphaned } = partitionRetiredNetworks(
      ['evmos', 'harmony', 'moonbeam', 'okx', 'velas'].map((network) =>
        parked({ network })
      ),
      known
    )
    expect(reconcilable).toEqual([])
    expect(orphaned.map((o) => o.network)).toEqual([
      'evmos',
      'harmony',
      'moonbeam',
      'okx',
      'velas',
    ])
  })
})

describe('formatOrphanedTaskMessage', () => {
  it('returns an empty string when no task sits on a retired network', () => {
    expect(formatOrphanedTaskMessage([])).toBe('')
  })

  it('names the network, facet, status and PR of each orphan', () => {
    const msg = formatOrphanedTaskMessage([
      {
        network: 'harmony',
        environment: EnvironmentEnum.production,
        facet: 'GenericSwapFacet',
        status: 'queued',
        prUrl: 'https://gh/pull/2046',
      },
    ])
    expect(msg).toContain('config/networks.json')
    expect(msg).toContain('harmony')
    expect(msg).toContain('GenericSwapFacet')
    expect(msg).toContain('queued')
    expect(msg).toContain('https://gh/pull/2046')
  })
})

describe('formatReconcileFailureMessage', () => {
  it('returns an empty string when every network reconciled', () => {
    expect(formatReconcileFailureMessage([])).toBe('')
  })

  it('names the failed group, its task count and the underlying reason', () => {
    const msg = formatReconcileFailureMessage([
      {
        network: 'zksync',
        environment: EnvironmentEnum.production,
        reason: 'HTTP request failed',
        taskCount: 3,
      },
    ])
    expect(msg).toContain('zksync')
    expect(msg).toContain('3 task(s)')
    expect(msg).toContain('HTTP request failed')
  })
})

describe('joinAlertSections', () => {
  it('drops empty sections so a single populated one carries no blank padding', () => {
    expect(joinAlertSections('', 'orphans', '')).toBe('orphans')
  })

  it('separates populated sections with a blank line', () => {
    expect(joinAlertSections('ttl', 'orphans')).toBe('ttl\n\norphans')
  })

  it('returns an empty string when there is nothing to report', () => {
    expect(joinAlertSections('', '', '')).toBe('')
  })
})
