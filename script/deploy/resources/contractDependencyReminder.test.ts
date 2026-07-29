import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  buildDependencyReminder,
  collectTransitiveDependents,
  type IDependencyEntry,
} from './contractDependencyReminder'

const REQUIREMENTS: Record<string, IDependencyEntry> = {
  Executor: { contractAddresses: { ERC20Proxy: {} } },
  ReceiverAcrossV4: { contractAddresses: { Executor: {} } },
  ReceiverStargateV2: { contractAddresses: { Executor: {} } },
  SomeFacet: {},
}

describe('collectTransitiveDependents', () => {
  it('finds direct dependents', () => {
    const dependents = collectTransitiveDependents('Executor', REQUIREMENTS)

    expect(dependents).toEqual([
      { contract: 'ReceiverAcrossV4', via: [] },
      { contract: 'ReceiverStargateV2', via: [] },
    ])
  })

  it('walks the graph transitively with the path recorded', () => {
    const dependents = collectTransitiveDependents('ERC20Proxy', REQUIREMENTS)

    expect(dependents).toEqual([
      { contract: 'Executor', via: [] },
      { contract: 'ReceiverAcrossV4', via: ['Executor'] },
      { contract: 'ReceiverStargateV2', via: ['Executor'] },
    ])
  })

  it('returns nothing for a contract nobody depends on', () => {
    expect(collectTransitiveDependents('SomeFacet', REQUIREMENTS)).toEqual([])
  })

  it('is cycle-safe', () => {
    const cyclic = {
      A: { contractAddresses: { B: {} } },
      B: { contractAddresses: { A: {} } },
    }

    // Sorted by contract name; A appears as its own transitive dependent through B.
    expect(collectTransitiveDependents('A', cyclic)).toEqual([
      { contract: 'A', via: ['B'] },
      { contract: 'B', via: [] },
    ])
  })
})

describe('buildDependencyReminder', () => {
  const ADDR = '0x1111111111111111111111111111111111111111'

  it('lists only dependents deployed on this network', () => {
    const reminder = buildDependencyReminder(
      'Executor',
      'mainnet',
      { ReceiverAcrossV4: ADDR },
      REQUIREMENTS
    )

    expect(reminder).toContain('Redeploying Executor')
    expect(reminder).toContain('ReceiverAcrossV4')
    expect(reminder).not.toContain('ReceiverStargateV2')
  })

  it('shows the transitive path for indirect dependents', () => {
    const reminder = buildDependencyReminder(
      'ERC20Proxy',
      'mainnet',
      { Executor: ADDR, ReceiverAcrossV4: ADDR },
      REQUIREMENTS
    )

    expect(reminder).toContain('Executor')
    expect(reminder).toContain('ReceiverAcrossV4 (via Executor)')
  })

  it('returns null when no dependent is deployed', () => {
    expect(
      buildDependencyReminder('Executor', 'mainnet', {}, REQUIREMENTS)
    ).toBeNull()
  })

  it('returns null for a contract nobody depends on', () => {
    expect(
      buildDependencyReminder(
        'SomeFacet',
        'mainnet',
        { ReceiverAcrossV4: ADDR },
        REQUIREMENTS
      )
    ).toBeNull()
  })
})

describe('real deployRequirements.json reverse graph', () => {
  it('Executor dependents include every coupled receiver with an entry', () => {
    const dependents = collectTransitiveDependents('Executor').map(
      (d) => d.contract
    )

    expect(dependents).toContain('ReceiverAcrossV4')
    expect(dependents).toContain('ReceiverStargateV2')
    expect(dependents).toContain('ReceiverChainflip')
    expect(dependents).toContain('ReceiverOIF')
  })

  it('ERC20Proxy dependents include the receivers transitively via Executor', () => {
    const dependents = collectTransitiveDependents('ERC20Proxy')
    const receiver = dependents.find((d) => d.contract === 'ReceiverAcrossV4')

    expect(dependents.map((d) => d.contract)).toContain('Executor')
    expect(receiver?.via).toEqual(['Executor'])
  })
})
