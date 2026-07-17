import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  HEALTH_CHECK_INVARIANTS,
  findDuplicateSelectors,
  isInvariantApplicable,
  type IHealthCheckInvariant,
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
