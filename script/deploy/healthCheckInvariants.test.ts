import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import networksConfig from '../../config/networks.json'

import {
  HEALTH_CHECK_EXCLUSIONS,
  HEALTH_CHECK_INVARIANTS,
  findDuplicateSelectors,
  getInvariantExclusion,
  isInvariantApplicable,
  type IHealthCheckInvariant,
  type IInvariantExclusion,
} from './healthCheckInvariants'

/** Minimal invariant descriptor for exercising the pure applicability logic. */
function makeInvariant(
  scope: IHealthCheckInvariant['scope']
): IHealthCheckInvariant {
  return {
    name: 'test',
    description: 'test',
    severity: 'error',
    scope,
    run: async () => undefined,
  }
}

const CTX = {
  production: {
    evm: {
      environment: 'production',
      isTron: false,
      isTestnet: false,
      supportsGasZip: true,
    },
    tron: {
      environment: 'production',
      isTron: true,
      isTestnet: false,
      supportsGasZip: true,
    },
    testnet: {
      environment: 'production',
      isTron: false,
      isTestnet: true,
      supportsGasZip: true,
    },
    noGasZip: {
      environment: 'production',
      isTron: false,
      isTestnet: false,
      supportsGasZip: false,
    },
  },
  staging: {
    environment: 'staging',
    isTron: false,
    isTestnet: false,
    supportsGasZip: true,
  },
} as const

describe('findDuplicateSelectors', () => {
  it('returns nothing for an empty facet list', () => {
    expect(findDuplicateSelectors([])).toEqual([])
  })

  it('returns nothing when every selector is unique', () => {
    const result = findDuplicateSelectors([
      { address: '0xAAA', selectors: ['0x11111111', '0x22222222'] },
      { address: '0xBBB', selectors: ['0x33333333'] },
    ])
    expect(result).toEqual([])
  })

  it('flags a selector registered by two different facets', () => {
    const result = findDuplicateSelectors([
      { address: '0xAAA', selectors: ['0x11111111'] },
      { address: '0xBBB', selectors: ['0x11111111'] },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.selector).toBe('0x11111111')
    expect(result[0]?.addresses.sort()).toEqual(['0xaaa', '0xbbb'])
  })

  it('is case-insensitive on selectors and addresses', () => {
    const result = findDuplicateSelectors([
      { address: '0xAbC', selectors: ['0xDEADBEEF'] },
      { address: '0xDeF', selectors: ['0xdeadbeef'] },
    ])
    expect(result).toHaveLength(1)
    expect(result[0]?.selector).toBe('0xdeadbeef')
  })

  it('does not flag a selector the same facet lists twice', () => {
    const result = findDuplicateSelectors([
      { address: '0xAAA', selectors: ['0x11111111', '0x11111111'] },
    ])
    expect(result).toEqual([])
  })
})

describe('isInvariantApplicable', () => {
  it('applies everywhere for an empty scope', () => {
    const inv = makeInvariant({})
    expect(isInvariantApplicable(inv, CTX.production.evm)).toBe(true)
    expect(isInvariantApplicable(inv, CTX.production.tron)).toBe(true)
    expect(isInvariantApplicable(inv, CTX.staging)).toBe(true)
  })

  it('gates on environment', () => {
    const inv = makeInvariant({ environments: ['production'] })
    expect(isInvariantApplicable(inv, CTX.production.evm)).toBe(true)
    expect(isInvariantApplicable(inv, CTX.staging)).toBe(false)
  })

  it('gates on evm-only chains', () => {
    const inv = makeInvariant({ chains: 'evm-only' })
    expect(isInvariantApplicable(inv, CTX.production.evm)).toBe(true)
    expect(isInvariantApplicable(inv, CTX.production.tron)).toBe(false)
  })

  it('gates on tron-only chains', () => {
    const inv = makeInvariant({ chains: 'tron-only' })
    expect(isInvariantApplicable(inv, CTX.production.evm)).toBe(false)
    expect(isInvariantApplicable(inv, CTX.production.tron)).toBe(true)
  })

  it('skips testnet when skipTestnet is set', () => {
    const inv = makeInvariant({ skipTestnet: true })
    expect(isInvariantApplicable(inv, CTX.production.evm)).toBe(true)
    expect(isInvariantApplicable(inv, CTX.production.testnet)).toBe(false)
  })

  it('requires GasZip support when requiresGasZip is set', () => {
    const inv = makeInvariant({ requiresGasZip: true })
    expect(isInvariantApplicable(inv, CTX.production.evm)).toBe(true)
    expect(isInvariantApplicable(inv, CTX.production.noGasZip)).toBe(false)
  })

  it('combines multiple scope conditions (all must pass)', () => {
    const inv = makeInvariant({
      environments: ['production'],
      chains: 'evm-only',
      skipTestnet: true,
    })
    expect(isInvariantApplicable(inv, CTX.production.evm)).toBe(true)
    expect(isInvariantApplicable(inv, CTX.production.tron)).toBe(false)
    expect(isInvariantApplicable(inv, CTX.production.testnet)).toBe(false)
    expect(isInvariantApplicable(inv, CTX.staging)).toBe(false)
  })
})

describe('HEALTH_CHECK_INVARIANTS registry', () => {
  it('has unique invariant names', () => {
    const names = HEALTH_CHECK_INVARIANTS.map((i) => i.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('uses only known severities', () => {
    for (const inv of HEALTH_CHECK_INVARIANTS)
      expect(['error', 'warning']).toContain(inv.severity)
  })

  it('gives every invariant a non-empty description', () => {
    for (const inv of HEALTH_CHECK_INVARIANTS)
      expect(inv.description.length).toBeGreaterThan(0)
  })

  it('halts only on the diamond-deployed prerequisite', () => {
    const halting = HEALTH_CHECK_INVARIANTS.filter((i) => i.haltIfFailed)
    expect(halting.map((i) => i.name)).toEqual(['diamond-deployed'])
  })

  it('includes the bug-bounty-#292 Executor↔ERC20Proxy binding invariant', () => {
    const names = HEALTH_CHECK_INVARIANTS.map((i) => i.name)
    expect(names).toContain('executor-erc20proxy-binding')
    expect(names).toContain('receiver-executor-binding')
  })
})

describe('getInvariantExclusion', () => {
  const sample: IInvariantExclusion[] = [
    {
      invariant: 'safe-config',
      network: 'somechain',
      reason: 'no Safe on somechain',
    },
  ]

  it('returns the matching exclusion', () => {
    const result = getInvariantExclusion('safe-config', 'somechain', sample)
    expect(result?.reason).toBe('no Safe on somechain')
  })

  it('matches the network case-insensitively', () => {
    const result = getInvariantExclusion('safe-config', 'SomeChain', sample)
    expect(result?.reason).toBe('no Safe on somechain')
  })

  it('returns undefined for a non-excluded invariant/network', () => {
    expect(
      getInvariantExclusion('safe-config', 'otherchain', sample)
    ).toBeUndefined()
    expect(
      getInvariantExclusion('whitelist-integrity', 'somechain', sample)
    ).toBeUndefined()
  })

  it('defaults to the real exclusion table', () => {
    // Smoke: the default arg is HEALTH_CHECK_EXCLUSIONS (empty today → always undefined).
    expect(getInvariantExclusion('safe-config', 'somechain')).toBeUndefined()
  })
})

describe('HEALTH_CHECK_EXCLUSIONS table integrity', () => {
  const invariantNames = new Set(HEALTH_CHECK_INVARIANTS.map((i) => i.name))
  const knownNetworks = new Set(Object.keys(networksConfig))

  it('every exclusion targets a real invariant name (guards stale carve-outs)', () => {
    for (const exclusion of HEALTH_CHECK_EXCLUSIONS)
      expect(invariantNames).toContain(exclusion.invariant)
  })

  it('every exclusion targets a known network', () => {
    for (const exclusion of HEALTH_CHECK_EXCLUSIONS)
      expect(knownNetworks).toContain(exclusion.network.toLowerCase())
  })

  it('every exclusion carries a non-empty reason', () => {
    for (const exclusion of HEALTH_CHECK_EXCLUSIONS)
      expect(exclusion.reason.trim().length).toBeGreaterThan(0)
  })
})
