/**
 * Tests for the deferred diamond-cleanup reconcile job (reconcile-parked-tasks.ts).
 *
 * The pure decisions are exercised directly: {@link reconcileDecision} maps a task's
 * status + on-chain/proposal truth to a lifecycle transition,
 * {@link partitionByNetworkStatus} / {@link deprecatedNetworkDecision} /
 * {@link shouldCancelDeprecated} decide what happens to a task whose network is
 * outside the active set (and, crucially, when a cancellation may be applied),
 * {@link computeTtlAlerts} / {@link formatTtlAlertMessage} surface open tasks that
 * have aged past the TTL, {@link computeSafeToPrune} / {@link formatSafeToPruneReport}
 * name the deploy-log entries whose removal work is terminal, and
 * {@link ttlAlertDelivery} decides whether an alert is posted, logged, or treated as a
 * misconfiguration. The live CLI (Mongo/loupe/Slack wiring) is unit-test exempt,
 * mirroring the store's `getParkedTasksCollection()` carve-out. Error text bound for
 * Slack goes through {@link redactErrorReason} first.
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
  computeSafeToPrune,
  computeTtlAlerts,
  deprecatedNetworkDecision,
  formatReconcileAnomalyMessage,
  formatReconcileFailureMessage,
  formatReopenAlertMessage,
  formatSafeToPruneReport,
  formatTtlAlertMessage,
  partitionByNetworkStatus,
  parseTtlDays,
  redactErrorReason,
  reconcileExitError,
  reconcileDecision,
  isSuspectAddressSnapshot,
  resolveFacetPresence,
  shouldCancelDeprecated,
  shouldWithholdSuspectResolution,
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

  it('reopens an executed task whose facet is still routed and still removable', () => {
    expect(
      reconcileDecision(
        { status: 'executed' },
        {
          facetPresentOnChain: true,
          proposalStatus: 'executed',
          removable: true,
        }
      )
    ).toBe('reopen')
  })

  it('reopens a superseded task whose facet is still routed and still removable', () => {
    expect(
      reconcileDecision(
        { status: 'superseded' },
        { facetPresentOnChain: true, removable: true }
      )
    ).toBe('reopen')
  })

  it('does NOT reopen a routed facet the removal engine refuses (incident rollback)', () => {
    // Re-cutting the same address (a rollback, or a CREATE2 redeploy) makes the facet
    // live and target-state-expected again; reopening would queue a Remove for it.
    expect(
      reconcileDecision(
        { status: 'executed' },
        { facetPresentOnChain: true, removable: false }
      )
    ).toBe('keep')
  })

  it('does NOT reopen when removability cannot be determined', () => {
    expect(
      reconcileDecision(
        { status: 'executed' },
        { facetPresentOnChain: true, removable: undefined }
      )
    ).toBe('keep')
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

  it('reports present when the stored address is routed', () => {
    expect(
      resolveFacetPresence(task, new Set([task.facetAddress.toLowerCase()]))
    ).toBe(true)
  })

  it('matches the stored address case-insensitively', () => {
    expect(
      resolveFacetPresence(
        { ...task, facetAddress: addr(0xabc).toUpperCase() as Address },
        new Set([addr(0xabc).toLowerCase()])
      )
    ).toBe(true)
  })

  it('reports absent when the address is gone, even though a facet of that name still routes', () => {
    // A co-registered removal: SymbiosisFacet v1.0.0 is cut, v2.0.0 keeps the
    // name. Judging by name would leave this task open forever.
    expect(resolveFacetPresence(task, new Set(['0xdead']))).toBe(false)
  })
})

describe('isSuspectAddressSnapshot', () => {
  const task = { facetName: 'AcrossFacetV3', facetAddress: addr(0xabc) }

  it('flags the worldchain shape: address not routed, name still routed', () => {
    // The task carried lisk's AcrossFacetV3 address, so an address check said
    // "gone" while the named facet was still live on worldchain.
    expect(
      isSuspectAddressSnapshot(
        task,
        new Set(['AcrossFacetV3']),
        new Set(['0xdead'])
      )
    ).toBe(true)
  })

  it('does not flag a task whose address is still routed', () => {
    expect(
      isSuspectAddressSnapshot(
        task,
        new Set(['AcrossFacetV3']),
        new Set([task.facetAddress.toLowerCase()])
      )
    ).toBe(false)
  })

  it('does not flag a removal whose name is gone from the diamond too', () => {
    expect(
      isSuspectAddressSnapshot(
        task,
        new Set(['OtherFacet']),
        new Set(['0xdead'])
      )
    ).toBe(false)
  })
})

describe('shouldWithholdSuspectResolution', () => {
  const routedNames = new Set(['SymbiosisFacet'])
  const routedAddresses = new Set([addr(0x2).toLowerCase()])
  const suspect = {
    facetName: 'SymbiosisFacet',
    facetAddress: addr(0x1),
  }

  it('withholds the worldchain shape: unclaimed task, address gone, name routed', () => {
    expect(
      shouldWithholdSuspectResolution({
        task: suspect,
        decision: 'superseded',
        routedNames,
        routedAddresses,
      })
    ).toBe(true)
  })

  it('resolves a claimed removal — the claim proves the address was routed here', () => {
    // The co-registered case (EXSC-750): the drain claimed v1.0.0 off this
    // diamond's loupe, so its absence is that removal landing, not a bad snapshot.
    // Withholding here would leave the task open forever on all 35 chains.
    expect(
      shouldWithholdSuspectResolution({
        task: { ...suspect, safeTxHash: '0xfeed' },
        decision: 'executed',
        routedNames,
        routedAddresses,
      })
    ).toBe(false)
  })

  it('never re-flags a task that needs no transition', () => {
    // An already-terminal task decides `keep`; gating it would re-alert every run
    // for a removal that completed correctly.
    for (const decision of ['keep', 'reopen', 'revert', 'cancel'] as const)
      expect(
        shouldWithholdSuspectResolution({
          task: suspect,
          decision,
          routedNames,
          routedAddresses,
        })
      ).toBe(false)
  })

  it('does not withhold when the name is gone from the diamond too', () => {
    expect(
      shouldWithholdSuspectResolution({
        task: suspect,
        decision: 'superseded',
        routedNames: new Set(['OtherFacet']),
        routedAddresses,
      })
    ).toBe(false)
  })
})

describe('formatReopenAlertMessage', () => {
  it('returns an empty string when nothing was reopened', () => {
    expect(formatReopenAlertMessage([], true)).toBe('')
  })

  it('groups reopened tasks by network and names the facet, prior status and PR', () => {
    const msg = formatReopenAlertMessage(
      [
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
      ],
      true
    )
    expect(msg).toContain('2 deferred diamond-cleanup task(s)')
    expect(msg).toContain('STILL ROUTED')
    expect(msg).toContain('[worldchain]')
    expect(msg).toContain('AcrossFacetV3 (was executed) → https://gh/pull/1')
    expect(msg).toContain('[lens]')
    expect(msg).toContain(
      'GenericSwapFacet (was superseded) → https://gh/pull/2'
    )
    expect(msg).toContain('re-queued for removal')
  })

  it('never claims a dry run re-queued anything', () => {
    const msg = formatReopenAlertMessage(
      [
        {
          network: 'worldchain',
          facet: 'AcrossFacetV3',
          prUrl: 'https://gh/pull/1',
          from: 'executed',
        },
      ],
      false
    )
    expect(msg).toContain('NOT yet re-queued')
    expect(msg).toContain('--yes')
    expect(msg).not.toContain('— re-queued for removal')
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
        kind: 'unreadable',
        reason: 'Chain harmony does not exist',
      },
      {
        network: 'velas',
        environment: EnvironmentEnum.production,
        kind: 'unreadable',
        reason: 'no LiFiDiamond in deploy log',
      },
    ])
    expect(msg).toContain('2 network(s) could not be reconciled')
    expect(msg).toContain('NOT verified')
    expect(msg).toContain('harmony:production — Chain harmony does not exist')
    expect(msg).toContain('velas:production — no LiFiDiamond in deploy log')
  })

  it('counts physical networks, not rows, when two environments of one network fail', () => {
    const msg = formatReconcileFailureMessage([
      {
        network: 'ethereum',
        environment: EnvironmentEnum.production,
        kind: 'unreadable',
        reason: 'RPC timeout',
      },
      {
        network: 'ethereum',
        environment: EnvironmentEnum.staging,
        kind: 'unreadable',
        reason: 'RPC timeout',
      },
    ])
    expect(msg).toContain('1 network(s) could not be reconciled')
    // Both rows are still listed — the count is deduped, the detail is not.
    expect(msg).toContain('ethereum:production')
    expect(msg).toContain('ethereum:staging')
  })
})
describe('reconcileExitError', () => {
  const failure = (
    kind: 'unreadable' | 'inactive-network',
    network: string
  ) => ({
    network,
    environment: EnvironmentEnum.production,
    kind,
    reason: 'reason',
  })

  it('exits 0 when the sweep collected nothing', () => {
    expect(reconcileExitError([])).toBe('')
  })

  it('keeps the cron green for a network that merely left the active set', () => {
    expect(
      reconcileExitError([
        failure('inactive-network', 'moonbeam'),
        failure('inactive-network', 'harmony'),
      ])
    ).toBe('')
  })

  it('reddens the run for a group whose state could not be read', () => {
    const msg = reconcileExitError([failure('unreadable', 'zksync')])
    expect(msg).toContain('1 network/environment group(s)')
    expect(msg).toContain('zksync:production')
  })

  it('reddens a mixed run and names only the unreadable groups', () => {
    const msg = reconcileExitError([
      failure('inactive-network', 'moonbeam'),
      failure('unreadable', 'zksync'),
    ])
    expect(msg).toContain('zksync:production')
    expect(msg).not.toContain('moonbeam')
  })
})

describe('formatReconcileAnomalyMessage', () => {
  const anomaly = (facet: string) => ({
    network: 'worldchain',
    environment: EnvironmentEnum.production,
    facet,
    prUrl: 'https://gh/pull/1',
    reason:
      'parked address is not routed, but a facet of the same name still is',
  })

  it('returns an empty string when nothing was withheld', () => {
    expect(formatReconcileAnomalyMessage([])).toBe('')
  })

  it('names the facet, the network and why no transition was applied', () => {
    const msg = formatReconcileAnomalyMessage([anomaly('AcrossFacetV3')])
    expect(msg).toContain('UNCHANGED')
    expect(msg).toContain('[worldchain:production] AcrossFacetV3')
    expect(msg).toContain('same name still is')
    expect(msg).toContain('https://gh/pull/1')
  })

  it('caps the listing so a fleet-wide anomaly cannot blow the Slack budget', () => {
    const msg = formatReconcileAnomalyMessage(
      Array.from({ length: 40 }, (_, i) => anomaly(`Facet${i}`))
    )
    expect(msg).toContain('40 deferred diamond-cleanup task(s)')
    expect(msg).toContain('and 25 more')
    expect(msg.length).toBeLessThan(2900)
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

  it('never cancels on a bare --network, which citty yields as an empty string', () => {
    // listParkedTasks treats '' as no filter at all, so '' is a fleet-wide run.
    expect(
      shouldCancelDeprecated('cancel', {
        apply: true,
        cancelDeprecated: true,
        networkFilter: '',
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

describe('computeSafeToPrune', () => {
  const always = () => true
  const notRouted = () => false

  it('reports a (network, facet) whose only task executed', () => {
    const r = computeSafeToPrune(
      [parked({ status: 'executed' })],
      always,
      notRouted
    )
    expect(r).toEqual([
      {
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facet: 'F',
      },
    ])
  })

  it('reports a superseded task (facet gone via another route)', () => {
    const r = computeSafeToPrune(
      [parked({ status: 'superseded' })],
      always,
      notRouted
    )
    expect(r).toHaveLength(1)
  })

  it('never reports while any task for the pair is still open', () => {
    const r = computeSafeToPrune(
      [
        parked({ status: 'executed' }),
        parked({ status: 'queued' }), // re-park of the same facet
      ],
      always,
      notRouted
    )
    expect(r).toHaveLength(0)
  })

  it('never reports a cancelled-only group (intent abandoned, facet may be live)', () => {
    const r = computeSafeToPrune(
      [parked({ status: 'cancelled' })],
      always,
      notRouted
    )
    expect(r).toHaveLength(0)
  })

  it('filters entries whose deploy-log row is already gone', () => {
    const r = computeSafeToPrune(
      [parked({ status: 'executed' })],
      () => false,
      notRouted
    )
    expect(r).toHaveLength(0)
  })

  it('holds back an entry whose logged address is still routed (the terminal task removed a superseded version; the row points at the live one)', () => {
    const r = computeSafeToPrune(
      [parked({ status: 'executed', facetName: 'SymbiosisFacet' })],
      always,
      () => true
    )
    expect(r).toHaveLength(0)
  })

  it('groups by network AND facet independently', () => {
    const r = computeSafeToPrune(
      [
        parked({ status: 'executed', facetName: 'A' }),
        parked({ status: 'queued', facetName: 'B' }),
        parked({ status: 'superseded', facetName: 'A', network: 'optimism' }),
      ],
      always,
      notRouted
    )
    expect(r).toEqual([
      {
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facet: 'A',
      },
      {
        network: 'optimism',
        environment: EnvironmentEnum.production,
        facet: 'A',
      },
    ])
  })
})

describe('formatSafeToPruneReport', () => {
  it('returns empty string when nothing is prunable', () => {
    expect(formatSafeToPruneReport([])).toBe('')
  })

  it('groups the report by network and names every facet', () => {
    const msg = formatSafeToPruneReport([
      {
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facet: 'A',
      },
      {
        network: 'arbitrum',
        environment: EnvironmentEnum.production,
        facet: 'B',
      },
      {
        network: 'optimism',
        environment: EnvironmentEnum.production,
        facet: 'C',
      },
    ])
    expect(msg).toContain('3')
    expect(msg).toContain('[arbitrum]')
    expect(msg).toContain('[optimism]')
    expect(msg).toContain('- A')
    expect(msg).toContain('- B')
    expect(msg).toContain('- C')
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

describe('redactErrorReason', () => {
  // Verbatim `error.message` of a viem HttpRequestError (viem@2.33.2) — the shape that
  // reaches the catch block, carrying the endpoint an RPC URL's API key lives in.
  const VIEM_HTTP_ERROR = [
    'HTTP request failed.',
    '',
    'URL: https://lb.drpc.org/ogrpc?network=base&dkey=SECRET-KEY-VALUE',
    'Request body: {"method":"eth_call"}',
    '',
    'Details: Was there a typo in the url or port?',
    'Version: viem@2.33.2',
  ].join('\n')

  it('strips the endpoint out of a real viem HTTP error', () => {
    const reason = redactErrorReason(VIEM_HTTP_ERROR)
    expect(reason).not.toContain('SECRET-KEY-VALUE')
    expect(reason).not.toContain('drpc.org')
    expect(reason).toContain('<redacted-url>')
    expect(reason).toContain('HTTP request failed.')
  })

  it('strips a mongo connection string, not only http endpoints', () => {
    const reason = redactErrorReason(
      'connect ECONNREFUSED mongodb+srv://user:pw@cluster.example.net/db'
    )
    expect(reason).not.toContain('pw@')
    expect(reason).toContain('<redacted-url>')
  })

  it('collapses the message to one line so the alert layout survives', () => {
    expect(redactErrorReason(VIEM_HTTP_ERROR)).not.toContain('\n')
  })

  it('caps an over-long message', () => {
    const reason = redactErrorReason('x'.repeat(500))
    expect(reason.length).toBeLessThanOrEqual(181)
    expect(reason.endsWith('…')).toBe(true)
  })

  it('leaves a plain message untouched', () => {
    expect(redactErrorReason('Deployments file not found for arbitrum')).toBe(
      'Deployments file not found for arbitrum'
    )
  })
})
