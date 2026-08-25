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
  isDeterministicReadFailure,
  RECEIVER_EXECUTOR_GETTERS,
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
import { getFacetPeripheryCouplings } from './shared/facetPeripheryCouplings'

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
    // Empty coverage, so no test ever reaches the real parked-task queue.
    openParkedRemovals: new Map(),
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

const EXECUTOR = '0x1111111111111111111111111111111111111111'
const OIF_ON_CHAIN = '0x2222222222222222222222222222222222222222'
const STARGATE_ON_CHAIN = '0x3333333333333333333333333333333333333333'
const REFUND_WALLET = '0x4444444444444444444444444444444444444444'
const WRONG = '0x5555555555555555555555555555555555555555'
const ZERO = '0x0000000000000000000000000000000000000000'

interface IReceiverStub {
  /** PeripheryRegistry contents: contract name -> address. */
  registry?: Record<string, string>
  /** Deploy log contents. */
  deployedContracts?: Record<string, string>
  /** Contract address -> the Executor its binding getter returns. */
  boundExecutor?: Record<string, string>
  /** Contract address -> its owner. */
  owner?: Record<string, string>
  /** Contract addresses whose non-registry reads throw a transport failure. */
  failingReads?: string[]
  /** Contract addresses whose non-registry reads revert on chain. */
  revertingReads?: string[]
  /** Contract addresses that hold no code, so the call decodes nothing. */
  zeroDataReads?: string[]
  /** Contract addresses whose read throws an error that resists inspection. */
  hostileErrorReads?: string[]
  /** Registry names whose read throws. */
  failingRegistryNames?: string[]
  /** Make every registry read fail as a rate limit. */
  rateLimitAll?: boolean
  /** Registry names whose read fails as a rate limit. */
  rateLimitNames?: string[]
}

/** Records every registry lookup so cache behaviour can be asserted. */
function makeReceiverCtx(stub: IReceiverStub): {
  ctx: IHealthCheckContext
  registryQueries: string[]
} {
  const registryQueries: string[] = []
  const ctx = makeCtx()
  Object.assign(ctx, {
    diamondAddress: '0x9999999999999999999999999999999999999999',
    refundWallet: REFUND_WALLET,
    coreFacetsToCheck: [],
    nonCoreFacets: [],
    diamondLogPeripheryNames: [],
    globalConfig: { whitelistPeripheryFunctions: {} },
    deployedContracts: {
      Executor: EXECUTOR,
      ...(stub.deployedContracts ?? {}),
    },
    peripheryRegistryCache: new Map(),
    publicClient: {
      readContract: async ({
        address,
        functionName,
        args,
      }: {
        address: string
        functionName: string
        args?: unknown[]
      }) => {
        if (functionName === 'getPeripheryContract') {
          const name = String(args?.[0])
          registryQueries.push(name)
          if (stub.rateLimitAll || stub.rateLimitNames?.includes(name))
            throw new Error('429 Too Many Requests')
          if (stub.failingRegistryNames?.includes(name))
            throw new Error('registry rpc boom')
          return stub.registry?.[name] ?? ZERO
        }
        if (stub.revertingReads?.includes(address))
          throw Object.assign(new Error('call failed'), {
            name: 'ContractFunctionExecutionError',
            cause: Object.assign(new Error('execution reverted'), {
              name: 'ContractFunctionRevertedError',
            }),
          })
        if (stub.zeroDataReads?.includes(address))
          throw Object.assign(new Error('call failed'), {
            name: 'ContractFunctionExecutionError',
            cause: Object.assign(new Error('returned no data ("0x")'), {
              name: 'ContractFunctionZeroDataError',
            }),
          })
        if (stub.hostileErrorReads?.includes(address)) {
          const hostile = new Error('hostile')
          Object.defineProperty(hostile, 'cause', {
            get() {
              throw new Error('cause getter exploded')
            },
          })
          throw hostile
        }
        if (stub.failingReads?.includes(address)) throw new Error('rpc boom')
        if (functionName === 'owner') return stub.owner?.[address] ?? ZERO
        return stub.boundExecutor?.[address] ?? ZERO
      },
    },
  })
  return { ctx, registryQueries }
}

const invariant = (name: string): IHealthCheckInvariant => {
  const found = HEALTH_CHECK_INVARIANTS.find((entry) => entry.name === name)
  if (!found) throw new Error(`invariant ${name} not found`)
  return found
}

describe('receiver-executor-binding registry-first resolution', () => {
  it('checks a receiver that is registered on chain but absent from the deploy log', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      boundExecutor: { [OIF_ON_CHAIN]: WRONG },
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverOIF')
  })

  it('passes when the registry-resolved receiver is bound to the deployed Executor', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      boundExecutor: { [OIF_ON_CHAIN]: EXECUTOR },
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors).toEqual([])
  })

  it('prefers the on-chain registry over a stale deploy-log address', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      deployedContracts: { ReceiverOIF: WRONG },
      boundExecutor: { [OIF_ON_CHAIN]: EXECUTOR, [WRONG]: WRONG },
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors).toEqual([])
  })

  it('falls back to the deploy log when the contract is not registered on chain', async () => {
    const { ctx } = makeReceiverCtx({
      deployedContracts: { ReceiverOIF: OIF_ON_CHAIN },
      boundExecutor: { [OIF_ON_CHAIN]: WRONG },
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverOIF')
  })

  it('compares against the Executor the diamond points at, not a stale logged one', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { Executor: STARGATE_ON_CHAIN, ReceiverOIF: OIF_ON_CHAIN },
      deployedContracts: { Executor: WRONG },
      boundExecutor: { [OIF_ON_CHAIN]: STARGATE_ON_CHAIN },
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors).toEqual([])
  })

  it('warns and still checks the remaining receivers when one binding read fails', async () => {
    const { ctx } = makeReceiverCtx({
      registry: {
        ReceiverOIF: OIF_ON_CHAIN,
        ReceiverStargateV2: STARGATE_ON_CHAIN,
      },
      failingReads: [OIF_ON_CHAIN],
      boundExecutor: { [STARGATE_ON_CHAIN]: WRONG },
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.warnings.some((w) => w.includes('ReceiverOIF'))).toBe(true)
    expect(ctx.errors.some((e) => e.includes('ReceiverStargateV2'))).toBe(true)
  })
})

describe('receiver-owner covers the bridge-specific receivers', () => {
  it('errors when a registry-resolved receiver has the wrong owner', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      owner: { [OIF_ON_CHAIN]: WRONG },
    })
    await invariant('receiver-owner').run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverOIF')
  })

  it('passes when every receiver owner is the refund wallet', async () => {
    const { ctx } = makeReceiverCtx({
      registry: {
        ReceiverOIF: OIF_ON_CHAIN,
        ReceiverStargateV2: STARGATE_ON_CHAIN,
      },
      owner: {
        [OIF_ON_CHAIN]: REFUND_WALLET,
        [STARGATE_ON_CHAIN]: REFUND_WALLET,
      },
    })
    await invariant('receiver-owner').run(ctx)
    expect(ctx.errors).toEqual([])
  })

  it('prefers the registry over a stale logged address for a receiver in service', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      deployedContracts: { ReceiverOIF: STARGATE_ON_CHAIN },
      owner: { [OIF_ON_CHAIN]: WRONG, [STARGATE_ON_CHAIN]: REFUND_WALLET },
    })
    await invariant('receiver-owner').run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverOIF')
  })

  it('warns and still checks the remaining receivers when one owner read fails', async () => {
    const { ctx } = makeReceiverCtx({
      registry: {
        ReceiverOIF: OIF_ON_CHAIN,
        ReceiverStargateV2: STARGATE_ON_CHAIN,
      },
      failingReads: [OIF_ON_CHAIN],
      owner: { [STARGATE_ON_CHAIN]: WRONG },
    })
    await invariant('receiver-owner').run(ctx)
    expect(ctx.warnings.some((w) => w.includes('ReceiverOIF'))).toBe(true)
    expect(ctx.errors.some((e) => e.includes('ReceiverStargateV2'))).toBe(true)
  })
})

describe('periphery registry read cache', () => {
  it('reads each registry name at most once across invariants sharing a context', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      boundExecutor: { [OIF_ON_CHAIN]: EXECUTOR },
      owner: { [OIF_ON_CHAIN]: REFUND_WALLET },
    })
    await invariant('receiver-executor-binding').run(ctx)
    await invariant('receiver-owner').run(ctx)

    const counts = new Map<string, number>()
    for (const name of registryQueries)
      counts.set(name, (counts.get(name) ?? 0) + 1)
    expect([...counts.values()].every((count) => count === 1)).toBe(true)
  })

  it('does not cache a failed registry read, so a retry reaches the RPC again', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({
      failingRegistryNames: ['ReceiverOIF'],
    })
    await invariant('receiver-executor-binding').run(ctx)
    const afterFirst = registryQueries.filter((n) => n === 'ReceiverOIF').length
    await invariant('receiver-owner').run(ctx)
    const afterSecond = registryQueries.filter(
      (n) => n === 'ReceiverOIF'
    ).length
    expect(afterFirst).toBe(1)
    expect(afterSecond).toBe(2)
  })
})

describe('periphery-registry-log-sync invariant', () => {
  const sync = () => invariant('periphery-registry-log-sync')

  it('is a production-scoped warning, mirroring no-unexpected-facets', () => {
    expect(sync().severity).toBe('warning')
    expect(sync().scope.environments).toEqual(['production'])
  })

  it('probes every receiver in service without a log naming it first', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({})
    await sync().run(ctx)
    for (const { name } of RECEIVER_EXECUTOR_GETTERS)
      expect(registryQueries).toContain(name)
  })

  it('does not seed a deprecated receiver no deploy log names', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({})
    await sync().run(ctx)
    expect(registryQueries).not.toContain('Receiver')
    expect(registryQueries).not.toContain('ReceiverAcrossV3')
  })

  it('still reconciles a deprecated receiver a deploy log names', async () => {
    // Not a contradiction of the test above: a log entry is a claim this invariant exists to
    // check, whatever the contract's status. Only the static seed drops the deprecated names.
    const { ctx, registryQueries } = makeReceiverCtx({
      deployedContracts: { Receiver: STARGATE_ON_CHAIN },
      registry: { Receiver: OIF_ON_CHAIN },
    })
    await sync().run(ctx)
    expect(registryQueries).toContain('Receiver')
    expect(ctx.warnings.some((w) => w.includes('Receiver'))).toBe(true)
  })

  it('flags a contract registered on chain but missing from the deploy log', async () => {
    const { ctx } = makeReceiverCtx({ registry: { ReceiverOIF: OIF_ON_CHAIN } })
    await sync().run(ctx)
    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('ReceiverOIF')
    expect(ctx.warnings[0]).toContain('missing from the deploy log')
  })

  it('probes receiver names that no core or whitelist list contains', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({})
    await sync().run(ctx)
    expect(registryQueries).toContain('ReceiverOIF')
    expect(registryQueries).toContain('ReceiverStargateV2')
  })

  it('flags a deploy-log address that disagrees with the registry', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      deployedContracts: { ReceiverOIF: WRONG },
    })
    await sync().run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('the on-chain registry has')
  })

  it('leaves the timelock alone - it is the diamond owner, not periphery', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({
      registry: { LiFiTimelockController: WRONG },
      deployedContracts: { LiFiTimelockController: OIF_ON_CHAIN },
    })
    await sync().run(ctx)
    expect(registryQueries).not.toContain('LiFiTimelockController')
    expect(ctx.warnings).toEqual([])
  })

  it('stays silent when the registry and the deploy log agree', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      deployedContracts: { ReceiverOIF: OIF_ON_CHAIN },
    })
    await sync().run(ctx)
    expect(ctx.warnings).toEqual([])
    expect(ctx.errors).toEqual([])
  })

  it('compares EVM addresses regardless of checksum case', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN.toUpperCase().replace('0X', '0x') },
      deployedContracts: { ReceiverOIF: OIF_ON_CHAIN },
    })
    await sync().run(ctx)
    expect(ctx.warnings).toEqual([])
  })

  it('says nothing about a name that is not registered on chain', async () => {
    const { ctx } = makeReceiverCtx({
      deployedContracts: { ReceiverOIF: OIF_ON_CHAIN },
    })
    await sync().run(ctx)
    expect(ctx.warnings).toEqual([])
  })

  it('warns rather than errors when a registry read fails', async () => {
    const { ctx } = makeReceiverCtx({
      failingRegistryNames: ['ReceiverOIF'],
    })
    await sync().run(ctx)
    expect(ctx.errors).toEqual([])
    expect(
      ctx.warnings.some(
        (w) => w.includes('ReceiverOIF') && w.includes('Could not read')
      )
    ).toBe(true)
  })

  it('probes periphery named only by the deploy log, not just the static lists', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({
      deployedContracts: { LiFiDEXAggregator: OIF_ON_CHAIN },
    })
    await sync().run(ctx)
    expect(registryQueries).toContain('LiFiDEXAggregator')
  })

  it('probes periphery recorded only in the diamond log', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({})
    Object.assign(ctx, { diamondLogPeripheryNames: ['ReceiverAcrossV3'] })
    await sync().run(ctx)
    expect(registryQueries).toContain('ReceiverAcrossV3')
  })

  it('flags a diamond-log-only contract that is registered but absent from the deploy log', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverAcrossV3: OIF_ON_CHAIN },
    })
    Object.assign(ctx, { diamondLogPeripheryNames: ['ReceiverAcrossV3'] })
    await sync().run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('ReceiverAcrossV3')
    expect(ctx.warnings[0]).toContain('missing from the deploy log')
  })

  it('awaits Tron registry candidates one at a time (each read spawns a subprocess)', async () => {
    const { ctx } = makeReceiverCtx({})
    Object.assign(ctx, {
      isTron: true,
      tronRpcUrl: 'http://tron.invalid',
      publicClient: undefined,
      tronWeb: {},
    })

    let inFlight = 0
    let peakInFlight = 0
    // Intercepts at the cache, so this measures the invariant's await sequencing rather than the
    // troncast subprocess itself - sequencing is what bounds the subprocess count.
    const cache = (
      ctx as unknown as {
        peripheryRegistryCache: Map<string, Promise<string | null>>
      }
    ).peripheryRegistryCache
    const realGet = cache.get.bind(cache)
    cache.get = (key: string) => {
      const existing = realGet(key)
      if (existing) return existing
      const pending = (async () => {
        inFlight++
        peakInFlight = Math.max(peakInFlight, inFlight)
        await Promise.resolve()
        inFlight--
        return null
      })()
      cache.set(key, pending)
      return pending
    }

    await sync().run(ctx)
    expect(peakInFlight).toBe(1)
  })

  it('does not waste registry reads on facet names from the deploy log', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({
      deployedContracts: { AcrossFacetV4: OIF_ON_CHAIN },
    })
    Object.assign(ctx, { nonCoreFacets: ['AcrossFacetV4'] })
    await sync().run(ctx)
    expect(registryQueries).not.toContain('AcrossFacetV4')
    expect(registryQueries).not.toContain('LiFiDiamond')
  })

  it('skips a retired facet that lingers in the deploy log but left target state', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({
      deployedContracts: {
        MultichainFacet: OIF_ON_CHAIN,
        LiFiDiamondImmutable: STARGATE_ON_CHAIN,
      },
    })
    // Deliberately NOT in coreFacetsToCheck/nonCoreFacets: target state only names current facets,
    // so a retired one is exactly the case the name-based exclusion has to catch.
    await sync().run(ctx)
    expect(registryQueries).not.toContain('MultichainFacet')
    expect(registryQueries).not.toContain('LiFiDiamondImmutable')
  })

  it('collapses a rate-limited fan-out into a single warning', async () => {
    const { ctx } = makeReceiverCtx({
      deployedContracts: { LiFiDEXAggregator: OIF_ON_CHAIN },
      rateLimitAll: true,
    })
    await sync().run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('rate limit')
    expect(ctx.warnings[0]).toContain('went unchecked')
  })

  it('keeps a non-rate-limit failure named even when a rate limit also occurred', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      rateLimitNames: ['ReceiverStargateV2'],
      failingRegistryNames: ['ReceiverChainflip'],
    })
    await sync().run(ctx)
    expect(ctx.warnings.some((w) => w.includes('rate limit'))).toBe(true)
    expect(
      ctx.warnings.some(
        (w) =>
          w.includes('ReceiverChainflip') && w.includes('registry rpc boom')
      )
    ).toBe(true)
    expect(ctx.warnings.some((w) => w.includes('ReceiverStargateV2'))).toBe(
      false
    )
  })

  it('skips a retired packed facet variant that lingers in the deploy log', async () => {
    const { ctx, registryQueries } = makeReceiverCtx({
      deployedContracts: {
        CBridgeFacetPacked: OIF_ON_CHAIN,
        CelerIMFacetImmutable: STARGATE_ON_CHAIN,
      },
    })
    await sync().run(ctx)
    expect(registryQueries).not.toContain('CBridgeFacetPacked')
    expect(registryQueries).not.toContain('CelerIMFacetImmutable')
  })
})

describe('receiver coverage tracks the coupling registry', () => {
  it('checks no receiver that is deprecated', () => {
    // Deliberately one-directional. Asserting set EQUALITY against the coupling companions would
    // forbid ever checking a receiver that has no facet coupling, which is the wrong thing to
    // make hard; the reverse direction is covered below.
    const checked = RECEIVER_EXECUTOR_GETTERS.map((receiver) => receiver.name)
    expect(checked).not.toContain('Receiver')
    expect(checked).not.toContain('ReceiverAcrossV3')
  })

  it('ignores a deprecated receiver while still checking the live ones alongside it', async () => {
    // The live receiver with the wrong owner is the positive control: without it, an empty errors
    // array would also pass if the loop never ran at all.
    const { ctx } = makeReceiverCtx({
      registry: {
        Receiver: OIF_ON_CHAIN,
        ReceiverAcrossV3: OIF_ON_CHAIN,
        ReceiverStargateV2: STARGATE_ON_CHAIN,
      },
      owner: { [OIF_ON_CHAIN]: WRONG, [STARGATE_ON_CHAIN]: WRONG },
      boundExecutor: { [OIF_ON_CHAIN]: WRONG, [STARGATE_ON_CHAIN]: WRONG },
    })
    await invariant('receiver-owner').run(ctx)
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors).toHaveLength(2)
    for (const error of ctx.errors)
      expect(error).toContain('ReceiverStargateV2')
  })

  it('gives every coupled Receiver an executor-binding and owner check', () => {
    const checked = new Set(
      RECEIVER_EXECUTOR_GETTERS.map((receiver) => receiver.name)
    )
    const coupledReceivers = Object.values(getFacetPeripheryCouplings())
      .map((coupling) => coupling.requires)
      .filter((companion) => companion.startsWith('Receiver'))

    expect(coupledReceivers.length).toBeGreaterThan(0)
    for (const receiver of coupledReceivers)
      expect(checked.has(receiver)).toBe(true)
  })
})

describe('selector identity in the facet invariants', () => {
  const FACET_A = '0xaaaa000000000000000000000000000000000001'
  const UNLOGGED = '0xbbbb000000000000000000000000000000000002'

  function makeFacetCtx(
    onChainFacets: Array<{ address: string; selectors: string[] }>,
    deployedContracts: Record<string, string>,
    compiledFacetSelectors: Record<string, string[]>
  ): IHealthCheckContext {
    const ctx = makeCtx()
    Object.assign(ctx, {
      onChainFacets,
      deployedContracts,
      compiledFacetSelectors,
    })
    return ctx
  }

  it('names an unlogged on-chain facet from its selectors', async () => {
    const ctx = makeFacetCtx(
      [{ address: UNLOGGED, selectors: ['0x11111111'] }],
      {},
      { AcrossFacetV4: ['0x11111111'] }
    )
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('AcrossFacetV4')
  })

  it('says so when no compiled selector set identifies an unlogged facet', async () => {
    const ctx = makeFacetCtx(
      [{ address: UNLOGGED, selectors: ['0x99999999'] }],
      {},
      { AcrossFacetV4: ['0x11111111'] }
    )
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('no compiled selector set identifies it')
  })

  it('leaves a deploy-log-named facet alone', async () => {
    const ctx = makeFacetCtx(
      [{ address: FACET_A, selectors: ['0x11111111'] }],
      { AcrossFacetV4: FACET_A },
      { AcrossFacetV4: ['0x11111111'] }
    )
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toEqual([])
  })

  it('evaluates the coupling of a live facet the deploy log does not know about', async () => {
    // Pinned rather than "first key": a reordered registry, or a carve-out landing on the first
    // entry, would otherwise silently turn this into a no-op that still passes.
    const coupled = 'StargateFacetV2'
    expect(getFacetPeripheryCouplings()[coupled]?.requires).toBeDefined()
    const ctx = makeFacetCtx(
      [{ address: UNLOGGED, selectors: ['0x11111111'] }],
      {},
      { [coupled]: ['0x11111111'] }
    )
    Object.assign(ctx, {
      diamondAddress: '0x9999999999999999999999999999999999999999',
      publicClient: {
        readContract: async () => ZERO,
      },
      peripheryRegistryCache: new Map(),
    })
    await invariant('facet-required-periphery').run(ctx)
    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain(coupled)
  })
})

describe('no-unexpected-facets parked-removal coverage', () => {
  const PRUNED = '0xCCCC000000000000000000000000000000000003'
  const PR_URL = 'https://github.com/lifinance/contracts/pull/9999'

  function makePrunedCtx(
    openParkedRemovals: IHealthCheckContext['openParkedRemovals'],
    extra: Partial<IHealthCheckContext> = {}
  ): IHealthCheckContext {
    const ctx = makeCtx()
    Object.assign(ctx, {
      onChainFacets: [{ address: PRUNED, selectors: ['0x11111111'] }],
      deployedContracts: {},
      compiledFacetSelectors: { AcrossFacetV4: ['0x11111111'] },
      openParkedRemovals,
      ...extra,
    })
    return ctx
  }

  const covering = (): Map<string, Map<string, string>> =>
    new Map([['testnet1', new Map([[PRUNED.toLowerCase(), PR_URL]])]])

  it('downgrades a routed-but-pruned facet to expected-pending when a parked removal covers it', async () => {
    const ctx = makePrunedCtx(covering())
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toEqual([])
  })

  it('still warns when the open task covers a different address', async () => {
    const ctx = makePrunedCtx(
      new Map([
        [
          'testnet1',
          new Map([['0xdddd000000000000000000000000000000000004', PR_URL]]),
        ],
      ])
    )
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
  })

  it('keys coverage by network, not fleet-wide', async () => {
    const ctx = makePrunedCtx(
      new Map([['othernet', new Map([[PRUNED.toLowerCase(), PR_URL]])]])
    )
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
  })

  it('degrades to the plain warning when the queue is unreachable', async () => {
    const ctx = makePrunedCtx({ unreachable: 'connect ECONNREFUSED' })
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('absent from the deploy log')
  })

  it('does not consult the queue on staging', async () => {
    const ctx = makePrunedCtx(covering(), { environment: 'staging' })
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
  })

  it('does not consult the queue on testnets', async () => {
    const ctx = makePrunedCtx(covering(), { isTestnet: true })
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
  })

  it('warns on the uncovered facet while downgrading the covered one', async () => {
    const UNCOVERED = '0xEEEE000000000000000000000000000000000005'
    const ctx = makePrunedCtx(covering(), {
      onChainFacets: [
        { address: PRUNED, selectors: ['0x11111111'] },
        { address: UNCOVERED, selectors: ['0x22222222'] },
      ],
    })
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain(UNCOVERED)
  })
})

describe('no-unexpected-facets without build output', () => {
  it('says identification was unavailable rather than claiming nothing matched', async () => {
    const ctx = makeCtx()
    Object.assign(ctx, {
      onChainFacets: [
        {
          address: '0xbbbb000000000000000000000000000000000002',
          selectors: ['0x11111111'],
        },
      ],
      deployedContracts: {},
      compiledFacetSelectors: {},
    })
    await invariant('no-unexpected-facets').run(ctx)
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('no build output available')
  })
})

describe('isDeterministicReadFailure', () => {
  it('treats a contract revert as deterministic', () => {
    expect(
      isDeterministicReadFailure(
        Object.assign(new Error('x'), { name: 'ContractFunctionRevertedError' })
      )
    ).toBe(true)
  })

  it('treats an address holding no code as deterministic', () => {
    expect(
      isDeterministicReadFailure(
        Object.assign(new Error('x'), { name: 'ContractFunctionZeroDataError' })
      )
    ).toBe(true)
  })

  it('unwraps a nested cause chain', () => {
    expect(
      isDeterministicReadFailure(
        Object.assign(new Error('outer'), {
          cause: new Error('execution reverted'),
        })
      )
    ).toBe(true)
  })

  it('treats a rate limit as transient', () => {
    expect(isDeterministicReadFailure(new Error('429 Too Many Requests'))).toBe(
      false
    )
  })

  it('treats a transport failure as transient', () => {
    expect(isDeterministicReadFailure(new Error('HTTP request failed'))).toBe(
      false
    )
  })

  it('defaults an unrecognised failure to transient', () => {
    expect(isDeterministicReadFailure('something odd')).toBe(false)
  })

  it('survives a self-referential cause chain', () => {
    const looping = new Error('loop') as Error & { cause?: unknown }
    looping.cause = looping
    expect(isDeterministicReadFailure(looping)).toBe(false)
  })
})

describe('receiver read failures separate broken contracts from flaky RPCs', () => {
  it('errors when a receiver owner read reverts, and still checks the rest', async () => {
    const { ctx } = makeReceiverCtx({
      registry: {
        ReceiverOIF: OIF_ON_CHAIN,
        ReceiverStargateV2: STARGATE_ON_CHAIN,
      },
      revertingReads: [OIF_ON_CHAIN],
      owner: { [STARGATE_ON_CHAIN]: REFUND_WALLET },
    })
    await invariant('receiver-owner').run(ctx)
    expect(ctx.errors.some((e) => e.includes('ReceiverOIF'))).toBe(true)
    // the loop continued: the healthy receiver was still read
    expect(ctx.errors.some((e) => e.includes('ReceiverStargateV2'))).toBe(false)
  })

  it('only warns when a receiver owner read fails on transport', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      failingReads: [OIF_ON_CHAIN],
    })
    await invariant('receiver-owner').run(ctx)
    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.some((w) => w.includes('ReceiverOIF'))).toBe(true)
  })

  it('errors on a receiver address that holds no code (real nested shape)', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      zeroDataReads: [OIF_ON_CHAIN],
    })
    await invariant('receiver-owner').run(ctx)
    expect(ctx.errors.some((e) => e.includes('ReceiverOIF'))).toBe(true)
  })

  it('keeps checking the remaining receivers when an error resists inspection', async () => {
    const { ctx } = makeReceiverCtx({
      registry: {
        ReceiverOIF: OIF_ON_CHAIN,
        ReceiverStargateV2: STARGATE_ON_CHAIN,
      },
      hostileErrorReads: [OIF_ON_CHAIN],
      owner: { [STARGATE_ON_CHAIN]: WRONG },
    })
    await invariant('receiver-owner').run(ctx)
    // classification must never abort the loop: the later receiver is still reported
    expect(ctx.errors.some((e) => e.includes('ReceiverStargateV2'))).toBe(true)
  })

  it('errors when a receiver binding getter reverts', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      revertingReads: [OIF_ON_CHAIN],
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors.some((e) => e.includes('ReceiverOIF'))).toBe(true)
  })

  it('only warns when a receiver binding getter fails on transport', async () => {
    const { ctx } = makeReceiverCtx({
      registry: { ReceiverOIF: OIF_ON_CHAIN },
      failingReads: [OIF_ON_CHAIN],
    })
    await invariant('receiver-executor-binding').run(ctx)
    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.some((w) => w.includes('ReceiverOIF'))).toBe(true)
  })
})
