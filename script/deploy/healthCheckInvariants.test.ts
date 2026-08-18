import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { type Hex } from 'viem'

import globalConfig from '../../config/global.json'
import networksConfig from '../../config/networks.json'
import { EnvironmentEnum } from '../common/types'

import {
  CORE_FACET_EXEMPTIONS,
  HEALTH_CHECK_EXCLUSIONS,
  HEALTH_CHECK_INVARIANTS,
  findDeprecatedLiveFacets,
  splitByParkedCoverage,
  findDuplicateSelectors,
  getExemptCoreFacets,
  getExpectedPairs,
  getInvariantExclusion,
  isInvariantApplicable,
  runHealthCheckInvariants,
  type IHealthCheckContext,
  type IHealthCheckInvariant,
  type ICoreFacetExemption,
  type IInvariantExclusion,
} from './healthCheckInvariants'

/** Minimal in-scope context for driving the runner without any RPC. */
function makeCtx(): IHealthCheckContext {
  const errors: string[] = []
  const warnings: string[] = []
  return {
    networkLower: 'testnet1',
    environment: 'production',
    isTron: false,
    isTestnet: false,
    supportsGasZip: true,
    onChainFacets: [],
    errors,
    warnings,
    logError: (msg: string) => {
      errors.push(msg)
    },
    logWarn: (msg: string) => {
      warnings.push(msg)
    },
  } as unknown as IHealthCheckContext
}

/** Build a synthetic invariant with a given run body. */
function inv(
  name: string,
  run: IHealthCheckInvariant['run'],
  extra: Partial<IHealthCheckInvariant> = {}
): IHealthCheckInvariant {
  return {
    name,
    description: name,
    severity: 'error',
    scope: {},
    run,
    ...extra,
  }
}

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

describe('splitByParkedCoverage', () => {
  const V1 = '0x00000000000000000000000000000000000000A1'
  const V2 = '0x00000000000000000000000000000000000000a2'
  const facet = (name: string, address: string) => ({
    name,
    address: address as Hex,
    selectors: ['0xdeadbeef'] as Hex[],
  })

  it('counts a facet as covered when an open task carries its exact address', () => {
    const { parked, unparked } = splitByParkedCoverage(
      [facet('SymbiosisFacet', V1)],
      new Set([V1.toLowerCase()])
    )
    expect(parked.map((f) => f.address)).toEqual([V1])
    expect(unparked).toHaveLength(0)
  })

  it('does NOT count a same-NAME task on a different address as coverage', () => {
    // Both SymbiosisFacet versions routed (EXSC-750) with a task for v1 only: keying
    // on the name would classify v2 as expected-pending and never warn about it.
    const { parked, unparked } = splitByParkedCoverage(
      [facet('SymbiosisFacet', V1), facet('SymbiosisFacet', V2)],
      new Set([V1.toLowerCase()])
    )
    expect(parked.map((f) => f.address)).toEqual([V1])
    expect(unparked.map((f) => f.address)).toEqual([V2])
  })

  it('matches addresses case-insensitively', () => {
    const { parked } = splitByParkedCoverage(
      [facet('SymbiosisFacet', V1)],
      new Set([V1.toUpperCase().replace('0X', '0x').toLowerCase()])
    )
    expect(parked).toHaveLength(1)
  })

  it('reports everything as uncovered when the queue holds no open task', () => {
    const { parked, unparked } = splitByParkedCoverage(
      [facet('SymbiosisFacet', V1)],
      new Set()
    )
    expect(parked).toHaveLength(0)
    expect(unparked).toHaveLength(1)
  })
})

describe('findDeprecatedLiveFacets', () => {
  const LIVE = '0x00000000000000000000000000000000000000AA'
  const KEEP = '0x00000000000000000000000000000000000000bb'
  const SELECTORS: Hex[] = ['0xdeadbeef']

  /** A deprecated facet: routed, in the deploy log, absent from target state, source gone. */
  function base(): Parameters<typeof findDeprecatedLiveFacets>[0] {
    return {
      networkLower: 'worldchain',
      environment: EnvironmentEnum.production,
      onChainFacets: [{ address: LIVE, selectors: SELECTORS }],
      deployedContracts: { AcrossFacetV3: LIVE },
      expectedNames: new Set(['AcrossFacetV4']),
      protectedNames: new Set(['DiamondCutFacet']),
      sourceNames: new Set(['AcrossFacetV4']),
    }
  }

  it('flags a facet that is routed, absent from target state and whose source is gone', () => {
    const found = findDeprecatedLiveFacets(base())
    expect(found).toHaveLength(1)
    expect(found[0]?.name).toBe('AcrossFacetV3')
    expect(found[0]?.selectors).toEqual(SELECTORS)
  })

  it('ignores a facet that target state still expects', () => {
    expect(
      findDeprecatedLiveFacets({
        ...base(),
        expectedNames: new Set(['AcrossFacetV3']),
      })
    ).toHaveLength(0)
  })

  it('ignores a facet whose source still exists (target-state drift, not a deprecation)', () => {
    expect(
      findDeprecatedLiveFacets({
        ...base(),
        sourceNames: new Set(['AcrossFacetV3']),
      })
    ).toHaveLength(0)
  })

  it('never flags a protected facet, even when target state omits it', () => {
    expect(
      findDeprecatedLiveFacets({
        ...base(),
        deployedContracts: { DiamondCutFacet: LIVE },
      })
    ).toHaveLength(0)
  })

  it('ignores a routed address the deploy log cannot name (no-unexpected-facets owns that)', () => {
    expect(
      findDeprecatedLiveFacets({ ...base(), deployedContracts: {} })
    ).toHaveLength(0)
  })

  it('matches deploy-log addresses case-insensitively', () => {
    const found = findDeprecatedLiveFacets({
      ...base(),
      deployedContracts: { AcrossFacetV3: LIVE.toLowerCase() },
    })
    expect(found).toHaveLength(1)
  })

  it('returns nothing when the network has no target-state entry (would flag everything)', () => {
    expect(
      findDeprecatedLiveFacets({ ...base(), expectedNames: undefined })
    ).toHaveLength(0)
  })

  it('reports only the deprecated facet when an expected one is routed alongside it', () => {
    const found = findDeprecatedLiveFacets({
      ...base(),
      onChainFacets: [
        { address: LIVE, selectors: SELECTORS },
        { address: KEEP, selectors: ['0xfeedface'] },
      ],
      deployedContracts: { AcrossFacetV3: LIVE, AcrossFacetV4: KEEP },
    })
    expect(found.map((f) => f.name)).toEqual(['AcrossFacetV3'])
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

  it('includes the queue-aware stale-facet invariant as a production warning', () => {
    const inv = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'no-stale-registered-facets'
    )
    expect(inv).toBeDefined()
    expect(inv?.severity).toBe('warning')
    expect(inv?.scope.environments).toEqual(['production'])
    expect(inv?.scope.skipTestnet).toBe(true)
    expect(inv?.readsOnChainFacets).toBe(true)
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

describe('getExpectedPairs — periphery address resolution', () => {
  const SEL = '0x00a32e6c'
  const A = '0x9706b69De23Fe0B471Addd642175126B3A8BF071'
  const B = '0xE69b860Fb5F12552b9C7675966Ef9522fB734232'

  /** Build a whitelist config with only PERIPHERY entries for network 'somechain'. */
  const cfg = (entries: Array<{ name: string; address: string }>) =>
    ({
      DEXS: [],
      PERIPHERY: {
        somechain: entries.map((e) => ({
          ...e,
          selectors: [{ selector: SEL, signature: 'runVM()' }],
        })),
      },
    } as unknown as Parameters<typeof getExpectedPairs>[2])

  const run = async (
    entries: Array<{ name: string; address: string }>,
    deployed: Record<string, string> = {}
  ) => {
    const errors: string[] = []
    const warns: string[] = []
    const pairs = await getExpectedPairs(
      'somechain',
      deployed,
      cfg(entries),
      (m) => errors.push(m),
      (m) => warns.push(m)
    )
    return { pairs, errors, warns }
  }

  it('uses the config address even when the contract is not in deployments', async () => {
    // Regression: a name-keyed lookup dropped these entries, so their on-chain pairs were
    // then reported as stale. Composer is whitelisted but never deployed by this repo.
    const { pairs, warns } = await run([{ name: 'Composer', address: A }])
    expect(pairs).toEqual([{ contract: A.toLowerCase(), selector: SEL }])
    expect(warns).toEqual([])
  })

  it('keeps every entry when several share one name', async () => {
    const { pairs } = await run([
      { name: 'Composer', address: A },
      { name: 'Composer', address: B },
    ])
    expect(pairs.map((p) => p.contract)).toEqual([
      A.toLowerCase(),
      B.toLowerCase(),
    ])
  })

  it('does not warn about staleness when the name is not unique', async () => {
    // deployedContracts holds one address per name, so it cannot disambiguate these.
    const { warns } = await run(
      [
        { name: 'Composer', address: A },
        { name: 'Composer', address: B },
      ],
      { Composer: A }
    )
    expect(warns).toEqual([])
  })

  it('warns when a unique name disagrees with the deployed address', async () => {
    const { warns } = await run([{ name: 'Executor', address: A }], {
      Executor: B,
    })
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('may be stale')
  })

  it('warns, rather than silently skipping, when nothing resolves', async () => {
    const { pairs, warns } = await run([{ name: 'Ghost', address: '' }])
    expect(pairs).toEqual([])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('reduced coverage')
  })
})

describe('getExemptCoreFacets', () => {
  const sample: ICoreFacetExemption[] = [
    { facet: 'SomeFacet', reason: 'because', networks: ['somechain'] },
  ]

  it('returns the facet and reason for an exempt network', () => {
    expect(getExemptCoreFacets('somechain', sample)).toEqual([
      { facet: 'SomeFacet', reason: 'because' },
    ])
  })

  it('matches the network case-insensitively', () => {
    expect(getExemptCoreFacets('SomeChain', sample)).toHaveLength(1)
  })

  it('returns nothing for a network that is not listed, so new chains stay enforced', () => {
    expect(getExemptCoreFacets('brandnewchain', sample)).toEqual([])
  })
})

describe('CORE_FACET_EXEMPTIONS table integrity', () => {
  const coreFacets = new Set<string>(globalConfig.coreFacets)
  const knownNetworks = new Set(Object.keys(networksConfig))

  it('every exemption targets a facet that is actually core (guards stale grandfathering)', () => {
    for (const exemption of CORE_FACET_EXEMPTIONS)
      expect(coreFacets).toContain(exemption.facet)
  })

  it('every exempt network is a known network', () => {
    for (const exemption of CORE_FACET_EXEMPTIONS)
      for (const network of exemption.networks)
        expect(knownNetworks).toContain(network.toLowerCase())
  })

  it('every exemption carries a non-empty reason', () => {
    for (const exemption of CORE_FACET_EXEMPTIONS)
      expect(exemption.reason.trim().length).toBeGreaterThan(0)
  })

  it('lists no network twice per facet', () => {
    for (const exemption of CORE_FACET_EXEMPTIONS) {
      const lower = exemption.networks.map((n) => n.toLowerCase())
      expect(new Set(lower).size).toBe(lower.length)
    }
  })
})

describe('runHealthCheckInvariants (runner)', () => {
  it('merges concurrent invariants without clobbering each other errors', async () => {
    const ctx = makeCtx()
    await runHealthCheckInvariants(ctx, [
      inv('a', async (c) => c.logError('err-a')),
      inv('b', async (c) => c.logError('err-b')),
    ])
    expect(ctx.errors.sort()).toEqual(['err-a', 'err-b'])
  })

  it('clears a transient error that does not reproduce on re-verify', async () => {
    const ctx = makeCtx()
    let calls = 0
    await runHealthCheckInvariants(ctx, [
      inv('flaky', async (c) => {
        calls++
        if (calls === 1) c.logError('transient blip')
      }),
    ])
    expect(calls).toBe(2) // ran once, then re-verified
    expect(ctx.errors).toEqual([]) // transient failure not recorded
  })

  it('records a persistent error that reproduces on re-verify', async () => {
    const ctx = makeCtx()
    await runHealthCheckInvariants(ctx, [
      inv('broken', async (c) => c.logError('real drift')),
    ])
    expect(ctx.errors).toEqual(['real drift'])
  })

  it('does not re-verify a warning (only fatal errors)', async () => {
    const ctx = makeCtx()
    let calls = 0
    await runHealthCheckInvariants(ctx, [
      inv(
        'warner',
        async (c) => {
          calls++
          c.logWarn('heads up')
        },
        { severity: 'warning' }
      ),
    ])
    expect(calls).toBe(1)
    expect(ctx.warnings).toEqual(['heads up'])
  })

  it('propagates onChainFacets from a phase-1 writer to a phase-2 reader', async () => {
    const ctx = makeCtx()
    await runHealthCheckInvariants(ctx, [
      inv('writer', async (c) => {
        c.onChainFacets.push({ address: '0xA', selectors: ['0x11111111'] })
      }),
      inv(
        'reader',
        async (c) => {
          if (c.onChainFacets.length === 0) c.logError('reader saw no facets')
        },
        { readsOnChainFacets: true }
      ),
    ])
    expect(ctx.errors).toEqual([])
    expect(ctx.onChainFacets).toHaveLength(1)
  })

  it('halts remaining invariants when a haltIfFailed prerequisite fails', async () => {
    const ctx = makeCtx()
    let laterRan = false
    await runHealthCheckInvariants(ctx, [
      inv('prereq', async (c) => c.logError('diamond missing'), {
        haltIfFailed: true,
      }),
      inv('later', async () => {
        laterRan = true
      }),
    ])
    expect(laterRan).toBe(false)
    expect(ctx.errors).toEqual(['diamond missing'])
  })

  it('skips an out-of-scope invariant', async () => {
    const ctx = makeCtx() // environment: production
    let ran = false
    await runHealthCheckInvariants(ctx, [
      inv(
        'staging-only',
        async () => {
          ran = true
        },
        { scope: { environments: ['staging'] } }
      ),
    ])
    expect(ran).toBe(false)
  })
})
