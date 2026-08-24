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
  resolveTimelockSkipReason,
  tallyQueuedOpsByNetwork,
  type IPendingFetchResult,
  type TTimelockSkipReason,
} from './timelock-prefetch'

const networksConfig = networks as INetworksObject

const network = (name: string): INetworksObject[string] => {
  const entry = networksConfig[name]
  if (!entry)
    throw new Error(`Test fixture references unknown network: ${name}`)
  return entry
}

describe('tallyQueuedOpsByNetwork', () => {
  it('counts rows per network, case-insensitively', () => {
    const counts = tallyQueuedOpsByNetwork([
      { network: 'worldchain' },
      { network: 'tron' },
      { network: 'WorldChain' },
    ])

    expect(counts.get('worldchain')).toBe(2)
    expect(counts.get('tron')).toBe(1)
  })

  it('omits networks with no queued rows rather than storing zero', () => {
    const counts = tallyQueuedOpsByNetwork([{ network: 'tron' }])

    expect(counts.has('worldchain')).toBe(false)
    expect(counts.get('worldchain') ?? 0).toBe(0)
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
      new Map([['base', 2]])
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
      new Map([['base', 3]]),
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
    expect(outcome.mustExitWithError).toBe(false)
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
