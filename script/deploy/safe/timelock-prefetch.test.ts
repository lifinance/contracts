/**
 * Tests for the timelock executor's fleet pre-check: the queue tally, the
 * skip/failure classification that decides whether "0 pending" may be trusted,
 * and the real-deployments skip resolution.
 */
import { rmSync, writeFileSync } from 'fs'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import networks from '../../../config/networks.json'
import { EnvironmentEnum, type INetworksObject } from '../../common/types'
import { getDeploymentsFilePath } from '../../utils/deploymentHelpers'

import {
  assemblePrefetchResults,
  classifyPrefetchResults,
  countOpsByNetwork,
  resolveTimelockSkipReason,
  tallyOpsByNetwork,
  type IPendingFetchResult,
  type IQueueTally,
  type TQueueConnector,
  type TTimelockSkipReason,
} from './timelock-prefetch'
import { type TimelockQueueStatus } from './timelock-queue'

const networksConfig = networks as INetworksObject

const network = (name: string): INetworksObject[string] => {
  const entry = networksConfig[name]
  if (!entry)
    throw new Error(`Test fixture references unknown network: ${name}`)
  return entry
}

const queued = (name: string) => ({
  network: name,
  status: 'queued' as TimelockQueueStatus,
})
const blocked = (name: string) => ({
  network: name,
  status: 'blocked' as TimelockQueueStatus,
})

describe('tallyOpsByNetwork', () => {
  it('counts rows per network, case-insensitively', () => {
    const counts = tallyOpsByNetwork([
      queued('worldchain'),
      queued('tron'),
      queued('WorldChain'),
    ])

    expect(counts.get('worldchain')?.queued).toBe(2)
    expect(counts.get('tron')?.queued).toBe(1)
  })

  it('counts blocked rows separately from queued ones', () => {
    const counts = tallyOpsByNetwork([
      queued('mode'),
      blocked('mode'),
      blocked('worldchain'),
    ])

    expect(counts.get('mode')).toEqual({ queued: 1, blocked: 1 })
    expect(counts.get('worldchain')).toEqual({ queued: 0, blocked: 1 })
  })

  it('omits networks with no tallied rows rather than storing zero', () => {
    const counts = tallyOpsByNetwork([queued('tron')])

    expect(counts.has('worldchain')).toBe(false)
  })
})

describe('countOpsByNetwork', () => {
  const connectorReturning = (
    rows: { network: string; status: TimelockQueueStatus }[],
    close: () => Promise<void>
  ): TQueueConnector =>
    (async () => ({
      client: { close },
      timelockQueue: { find: () => ({ toArray: async () => rows }) },
    })) as unknown as TQueueConnector

  it('keeps the tally when closing the connection rejects', async () => {
    const counts = await countOpsByNetwork(
      ['tron'],
      connectorReturning([queued('tron')], () =>
        Promise.reject(new Error('connection reset during close'))
      )
    )

    expect(counts.get('tron')?.queued).toBe(1)
  })

  it('closes the connection once the tally is done', async () => {
    let closed = 0
    await countOpsByNetwork(
      ['tron'],
      connectorReturning([], async () => {
        closed++
      })
    )

    expect(closed).toBe(1)
  })
})

describe('assemblePrefetchResults', () => {
  const inputs = [network('mainnet'), network('base'), network('tronshasta')]
  const skips = new Map<string, TTimelockSkipReason>([
    ['tronshasta', 'no-deployment-log'],
  ])

  it('returns one result per input network, in input order', () => {
    const results = assemblePrefetchResults(
      inputs,
      skips,
      new Map<string, IQueueTally>([['base', { queued: 2, blocked: 0 }]])
    )

    expect(results.map((r) => r.network.name)).toEqual([
      'mainnet',
      'base',
      'tronshasta',
    ])
    expect(results[1]?.pendingInMongoCount).toBe(2)
    expect(results[0]?.pendingInMongoCount).toBe(0)
  })

  it('marks skipped networks as skipped, never as failed', () => {
    const results = assemblePrefetchResults(inputs, skips, new Map())
    const shasta = results.find((r) => r.network.name === 'tronshasta')

    expect(shasta?.skipReason).toBe('no-deployment-log')
    expect(shasta?.fetchError).toBeUndefined()
  })

  it('marks every non-skipped network as failed when the queue read failed', () => {
    const err = new Error('querySrv ETIMEOUT')
    const errors = new Map<string, unknown>([
      ['mainnet', err],
      ['base', err],
    ])
    const results = assemblePrefetchResults(inputs, skips, new Map(), errors)

    expect(
      results.filter((r) => r.fetchError === err).map((r) => r.network.name)
    ).toEqual(['mainnet', 'base'])
    // A skipped network has nothing to fail at, so the error must not reach it.
    expect(
      results.find((r) => r.network.name === 'tronshasta')?.fetchError
    ).toBeUndefined()
  })

  it('fails only the networks that actually errored', () => {
    const err = new Error('unreadable deployments file')
    const results = assemblePrefetchResults(
      inputs,
      new Map(),
      new Map<string, IQueueTally>([['base', { queued: 3, blocked: 0 }]]),
      new Map<string, unknown>([['mainnet', err]])
    )

    expect(results.find((r) => r.network.name === 'mainnet')?.fetchError).toBe(
      err
    )
    expect(
      results.find((r) => r.network.name === 'base')?.fetchError
    ).toBeUndefined()
    expect(
      results.find((r) => r.network.name === 'base')?.pendingInMongoCount
    ).toBe(3)
  })

  it('reports zero pending for a network absent from the tally', () => {
    const results = assemblePrefetchResults(inputs, new Map(), new Map())

    expect(results.every((r) => r.pendingInMongoCount === 0)).toBe(true)
  })
})

describe('classifyPrefetchResults', () => {
  const result = (
    name: string,
    overrides: Partial<IPendingFetchResult> = {}
  ): IPendingFetchResult => ({
    network: network(name),
    pendingInMongoCount: 0,
    blockedInMongoCount: 0,
    ...overrides,
  })

  it('refuses to trust "0 pending" when a network could not be checked', () => {
    const outcome = classifyPrefetchResults([
      result('mainnet', { fetchError: new Error('boom') }),
      result('base'),
    ])

    expect(outcome.withPending).toHaveLength(0)
    expect(outcome.failed.map((r) => r.network.name)).toEqual(['mainnet'])
    expect(outcome.mustExitWithError).toBe(true)
  })

  it('counts a falsy thrown value as a failure, not as a checked network', () => {
    // assemblePrefetchResults records a failure with `!== undefined`, so a
    // truthiness test here would let `throw ''` read as checked-with-0-pending.
    const outcome = classifyPrefetchResults([
      result('mainnet', { fetchError: '' }),
      result('base'),
    ])

    expect(outcome.failed.map((r) => r.network.name)).toEqual(['mainnet'])
    expect(outcome.mustExitWithError).toBe(true)
  })

  it('trusts "0 pending" when every network was reached', () => {
    const outcome = classifyPrefetchResults([result('mainnet'), result('base')])

    expect(outcome.mustExitWithError).toBe(false)
  })

  it('does not treat an expected skip as a reason to fail the run', () => {
    const outcome = classifyPrefetchResults([
      result('tronshasta', { skipReason: 'no-deployment-log' }),
      result('base'),
    ])

    expect(outcome.skipped.map((r) => r.network.name)).toEqual(['tronshasta'])
    expect(outcome.failed).toHaveLength(0)
    expect(outcome.mustExitWithError).toBe(false)
  })

  it('surfaces networks with queued ops', () => {
    const outcome = classifyPrefetchResults([
      result('mainnet', { pendingInMongoCount: 2 }),
      result('base'),
    ])

    expect(outcome.withPending.map((r) => r.network.name)).toEqual(['mainnet'])
    expect(outcome.toProcess.map((r) => r.network.name)).toEqual(['mainnet'])
    expect(outcome.mustExitWithError).toBe(false)
  })

  it('processes a network whose only rows are blocked (EXSC-816)', () => {
    // The regression that made a ready-but-blocked op invisible: this network
    // has nothing to execute, so it was dropped before alertBlockedOps ran.
    const outcome = classifyPrefetchResults([
      result('mode', { blockedInMongoCount: 1 }),
      result('base'),
    ])

    expect(outcome.withPending).toHaveLength(0)
    expect(outcome.withBlocked.map((r) => r.network.name)).toEqual(['mode'])
    expect(outcome.toProcess.map((r) => r.network.name)).toEqual(['mode'])
  })

  it('still runs the blocked re-check when another network failed to fetch', () => {
    // mustExitWithError must weigh blocked work too, or a blocked-only network
    // is abandoned the moment any other network is unreachable.
    const outcome = classifyPrefetchResults([
      result('mode', { blockedInMongoCount: 1 }),
      result('mainnet', { fetchError: new Error('querySrv ETIMEOUT') }),
    ])

    expect(outcome.mustExitWithError).toBe(false)
    expect(outcome.failed.map((r) => r.network.name)).toEqual(['mainnet'])
  })
})

describe('resolveTimelockSkipReason (real deployments/)', () => {
  it('skips an active network that has no production deployments file', async () => {
    // tronshasta is `status: active` in networks.json but was never brought up
    // in production, so it has no deployments/tronshasta.json. Before this was
    // a skip it surfaced as a prefetch error with a full stack trace.
    expect(await resolveTimelockSkipReason(network('tronshasta'))).toBe(
      'no-deployment-log'
    )
  })

  it('does not skip a network whose deployments file has a timelock', async () => {
    expect(await resolveTimelockSkipReason(network('mainnet'))).toBeUndefined()
  })

  it('refuses to skip a network whose deployments file exists but will not load', async () => {
    // getDeployments reports an unreadable file as not-found, so classifying
    // every throw as a skip would hide a network that does have a timelock.
    // tronshasta has no deployments file, so we can create one and remove it
    // again without disturbing a tracked file.
    const filePath = getDeploymentsFilePath(
      'tronshasta',
      EnvironmentEnum.production
    )
    writeFileSync(filePath, '{ this is not valid json')
    let thrown: unknown
    try {
      await resolveTimelockSkipReason(network('tronshasta'))
    } catch (err) {
      thrown = err
    } finally {
      rmSync(filePath, { force: true })
    }

    expect(thrown).toBeInstanceOf(Error)
  })
})
