import { existsSync } from 'fs'
import { resolve } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import globalConfig from '../../config/global.json'
import networksConfig from '../../config/networks.json'

import {
  CORE_FACET_EXEMPTIONS,
  CORE_PERIPHERY_EXEMPTIONS,
  DEPRECATED_RECEIVERS,
  filterExemptCorePeriphery,
  HEALTH_CHECK_EXCLUSIONS,
  HEALTH_CHECK_INVARIANTS,
  RECEIVER_EXECUTOR_GETTERS,
  findDuplicateSelectors,
  getExemptCoreFacets,
  getExpectedPairs,
  getInvariantExclusion,
  isNonZeroTronAddress,
  isInvariantApplicable,
  runHealthCheckInvariants,
  type IHealthCheckContext,
  type IHealthCheckInvariant,
  type ICoreFacetExemption,
  type IInvariantExclusion,
} from './healthCheckInvariants'
import {
  getFacetPeripheryCouplings,
  loadFacetRegisteredSelectors,
} from './shared/facetPeripheryCouplings'
import { collectImmutableBindingChecks } from './shared/immutableBindings'

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
    peripheryRegistryCache: new Map(),
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

describe('isNonZeroTronAddress', () => {
  it('accepts a real Tron contract address', () => {
    expect(isNonZeroTronAddress('TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt')).toBe(
      true
    )
  })

  it('rejects the Tron zero address (a well-formed T... string that means "unset")', () => {
    expect(isNonZeroTronAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')).toBe(
      false
    )
  })

  it('rejects malformed output', () => {
    expect(isNonZeroTronAddress('')).toBe(false)
    expect(
      isNonZeroTronAddress('0x0000000000000000000000000000000000000000')
    ).toBe(false)
    expect(isNonZeroTronAddress('TooShort')).toBe(false)
  })
})

describe('facet-required-periphery invariant', () => {
  const FACET_ADDRESS = '0x1111111111111111111111111111111111111111'
  const RECEIVER_ADDRESS = '0x2222222222222222222222222222222222222222'
  const DIAMOND_ADDRESS = '0x3333333333333333333333333333333333333333'

  const invariant = HEALTH_CHECK_INVARIANTS.find(
    (i) => i.name === 'facet-required-periphery'
  ) as IHealthCheckInvariant

  /**
   * Context with `AcrossFacetV4` registered on chain, and a stub client that resolves
   * `getPeripheryContract(name)` from `registryEntries` (absent name => zero address).
   */
  function makeCouplingCtx(
    registryEntries: Record<string, string>,
    { liveFacets = true }: { liveFacets?: boolean } = {}
  ): IHealthCheckContext {
    const ctx = makeCtx()
    return Object.assign(ctx, {
      diamondAddress: DIAMOND_ADDRESS,
      deployedContracts: {
        AcrossFacetV4: FACET_ADDRESS,
        ReceiverAcrossV4: RECEIVER_ADDRESS,
      },
      onChainFacets: liveFacets
        ? [{ address: FACET_ADDRESS, selectors: ['0xaaaaaaaa'] }]
        : [],
      publicClient: {
        readContract: async ({ args }: { args: [string] }) =>
          registryEntries[args[0]] ??
          '0x0000000000000000000000000000000000000000',
      },
    } as unknown as IHealthCheckContext)
  }

  it('is registered as a production-scoped error that reads on-chain facets', () => {
    expect(invariant).toBeDefined()
    expect(invariant.severity).toBe('error')
    expect(invariant.readsOnChainFacets).toBe(true)
    expect(invariant.scope.environments).toEqual(['production'])
  })

  it('passes when the companion receiver is registered in the diamond', async () => {
    const ctx = makeCouplingCtx({ ReceiverAcrossV4: RECEIVER_ADDRESS })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toEqual([])
  })

  it('fails when a live facet has no companion registered', async () => {
    const ctx = makeCouplingCtx({})

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('AcrossFacetV4')
    expect(ctx.errors[0]).toContain('ReceiverAcrossV4')
    expect(ctx.errors[0]).toContain('destination calls')
  })

  it('does not accept the deprecated V3 receiver in place of ReceiverAcrossV4', async () => {
    const ctx = makeCouplingCtx({ ReceiverAcrossV3: RECEIVER_ADDRESS })

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverAcrossV4')
  })

  it('warns instead of silently passing when the on-chain facet list is unavailable', async () => {
    const ctx = makeCouplingCtx({}, { liveFacets: false })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('coupling check skipped')
  })

  it('warns instead of erroring when every companion lookup fails (a failed read is not absence)', async () => {
    const ctx = makeCouplingCtx({})
    ctx.publicClient = {
      readContract: async () => {
        throw new Error('RPC 429')
      },
    } as unknown as IHealthCheckContext['publicClient']

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.some((w) => w.includes('could not determine'))).toBe(
      true
    )
  })

  it('still evaluates the remaining companions when only one lookup fails', async () => {
    const ctx = makeCouplingCtx({})
    ctx.publicClient = {
      readContract: async ({ args }: { args: [string] }) => {
        if (args[0] === 'ReceiverAcrossV4') throw new Error('RPC 429')
        return RECEIVER_ADDRESS
      },
    } as unknown as IHealthCheckContext['publicClient']

    await invariant.run(ctx)

    // ReceiverAcrossV3 resolved and is registered, so the coupling is satisfied despite the
    // failed V4 lookup.
    expect(ctx.errors).toEqual([])
  })

  it('warns instead of silently returning when no chain client is available', async () => {
    const ctx = makeCouplingCtx({})
    ctx.publicClient = undefined

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.some((w) => w.includes('coupling check skipped'))).toBe(
      true
    )
  })

  it('does not require a companion for a facet without a declared coupling', async () => {
    const ctx = makeCouplingCtx({})
    ctx.deployedContracts = { GenericSwapFacetV3: FACET_ADDRESS }

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
  })

  it('requires ReceiverOIF wherever an intent-escrow facet is live', async () => {
    const ctx = makeCouplingCtx({})
    ctx.deployedContracts = { LiFiIntentEscrowFacetV2: FACET_ADDRESS }

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverOIF')
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

describe('CORE_PERIPHERY_EXEMPTIONS table integrity', () => {
  const corePeriphery = new Set(
    (globalConfig as { corePeriphery: string[] }).corePeriphery
  )
  const knownNetworks = new Set(Object.keys(networksConfig))

  it('every exemption targets a real core periphery contract', () => {
    for (const exemption of CORE_PERIPHERY_EXEMPTIONS)
      expect(corePeriphery).toContain(exemption.contract)
  })

  it('every exemption targets a known network with a non-empty reason', () => {
    for (const exemption of CORE_PERIPHERY_EXEMPTIONS) {
      expect(knownNetworks).toContain(exemption.network.toLowerCase())
      expect(exemption.reason.trim().length).toBeGreaterThan(0)
    }
  })

  it('filterExemptCorePeriphery drops only the exempt contract on the exempt network', () => {
    const exemptions = [
      { contract: 'TokenWrapper', network: 'somechain', reason: 'no native' },
    ]

    expect(
      filterExemptCorePeriphery(
        ['TokenWrapper', 'Executor'],
        'somechain',
        exemptions
      )
    ).toEqual(['Executor'])
    expect(
      filterExemptCorePeriphery(
        ['TokenWrapper', 'Executor'],
        'otherchain',
        exemptions
      )
    ).toEqual(['TokenWrapper', 'Executor'])
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

describe('coupling ↔ executor-binding registry drift', () => {
  it('every Receiver companion in facetPeripheryCouplings has an executor-binding check', () => {
    // Two parallel hand-maintained lists: the coupling registry (presence) and
    // RECEIVER_EXECUTOR_GETTERS (binding). A new Receiver added to one but not the other would
    // be presence-checked yet never binding-checked - silently. This ties them together.
    const companions = new Set(
      Object.values(getFacetPeripheryCouplings()).flatMap(
        (coupling) => coupling.requiresAnyOf
      )
    )
    const bindingChecked = new Set(
      RECEIVER_EXECUTOR_GETTERS.map((entry) => entry.name)
    )
    const missing = [...companions].filter(
      (name) =>
        name.startsWith('Receiver') &&
        !bindingChecked.has(name) &&
        !DEPRECATED_RECEIVERS.includes(name)
    )

    expect(missing).toEqual([])
  })
})

describe('periphery-registry-log-sync invariant', () => {
  const RECEIVER = '0x2222222222222222222222222222222222222222'
  const OTHER = '0x5555555555555555555555555555555555555555'
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const ZERO = '0x0000000000000000000000000000000000000000'

  const invariant = HEALTH_CHECK_INVARIANTS.find(
    (i) => i.name === 'periphery-registry-log-sync'
  ) as IHealthCheckInvariant

  /**
   * Context whose registry has only ReceiverOIF registered (at RECEIVER). The diamond log
   * defaults to agreeing with the registry so flat-log cases stay isolated; pass
   * `diamondLogPeriphery` explicitly (or null) to exercise the diamond-log comparisons.
   */
  function makeSyncCtx(
    deployedContracts: Record<string, string>,
    diamondLogPeriphery: Record<string, string> | null = {
      ReceiverOIF: RECEIVER,
    },
    registered: Record<string, string> = { ReceiverOIF: RECEIVER }
  ): IHealthCheckContext {
    const ctx = makeCtx()
    return Object.assign(ctx, {
      diamondAddress: DIAMOND,
      deployedContracts,
      diamondLogPeriphery,
      globalConfig: { whitelistPeripheryFunctions: {} },
      publicClient: {
        readContract: async ({ args }: { args: [string] }) =>
          registered[args[0]] ?? ZERO,
      },
    } as unknown as IHealthCheckContext)
  }

  it('is registered as a production-scoped warning (warning-first rollout)', () => {
    expect(invariant).toBeDefined()
    expect(invariant.severity).toBe('warning')
    expect(invariant.scope.environments).toEqual(['production'])
  })

  it('flags a registered contract missing from the deploy log', async () => {
    const ctx = makeSyncCtx({})

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('ReceiverOIF')
    expect(ctx.warnings[0]).toContain('missing from the deploy log')
  })

  it('flags a deploy log address that differs from the registry', async () => {
    const ctx = makeSyncCtx({ ReceiverOIF: OTHER })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('on-chain registry has')
  })

  it('passes when both logs and the registry agree', async () => {
    const ctx = makeSyncCtx({ ReceiverOIF: RECEIVER })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toEqual([])
  })

  it('warns instead of erroring when a registry read fails', async () => {
    const ctx = makeSyncCtx({})
    ctx.publicClient = {
      readContract: async () => {
        throw new Error('RPC 429')
      },
    } as unknown as IHealthCheckContext['publicClient']

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.length).toBeGreaterThan(0)
  })

  it('probes names known only to the flat deploy log (not any hand-maintained list)', async () => {
    // FeeCollector is in no coupling/getter/core list here, but the registry has it and the
    // flat log disagrees - the pre-widening candidate set would never have probed it.
    const ctx = makeSyncCtx(
      { FeeCollector: OTHER, ReceiverOIF: RECEIVER },
      { ReceiverOIF: RECEIVER, FeeCollector: RECEIVER },
      { ReceiverOIF: RECEIVER, FeeCollector: RECEIVER }
    )

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('FeeCollector')
    expect(ctx.warnings[0]).toContain('on-chain registry has')
  })

  it('flags a registered contract with an empty diamond log entry (the robinhood ReceiverOIF case)', async () => {
    const ctx = makeSyncCtx({ ReceiverOIF: RECEIVER }, { ReceiverOIF: '' })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('ReceiverOIF')
    expect(ctx.warnings[0]).toContain('.diamond.json')
  })

  it('flags a diamond log address that differs from the registry', async () => {
    const ctx = makeSyncCtx({ ReceiverOIF: RECEIVER }, { ReceiverOIF: OTHER })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('diamond log has')
  })

  it('probes names known only to the diamond log and flags the missing flat-log entry', async () => {
    const ctx = makeSyncCtx(
      {},
      { ReceiverOIF: RECEIVER, Composer: RECEIVER },
      { ReceiverOIF: RECEIVER, Composer: RECEIVER }
    )

    await invariant.run(ctx)

    expect(
      ctx.warnings.filter((e) => e.includes('missing from the deploy log'))
    ).toHaveLength(2)
    expect(ctx.warnings.join('\n')).toContain('Composer')
  })

  it('warns (not errors) on a diamond log entry that is not registered on chain', async () => {
    const ctx = makeSyncCtx(
      { ReceiverOIF: RECEIVER },
      { ReceiverOIF: RECEIVER, Patcher: OTHER }
    )

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('Patcher')
    expect(ctx.warnings[0]).toContain('not registered on chain')
  })

  it('warns about reduced coverage when the diamond log is unreadable', async () => {
    const ctx = makeSyncCtx({ ReceiverOIF: RECEIVER }, null)

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings).toHaveLength(1)
    expect(ctx.warnings[0]).toContain('diamond-log sync coverage skipped')
  })
})

describe('receiver-executor-binding registry-first resolution', () => {
  const RECEIVER = '0x2222222222222222222222222222222222222222'
  const EXECUTOR = '0x4444444444444444444444444444444444444444'
  const OTHER = '0x5555555555555555555555555555555555555555'
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const ZERO = '0x0000000000000000000000000000000000000000'

  const invariant = HEALTH_CHECK_INVARIANTS.find(
    (i) => i.name === 'receiver-executor-binding'
  ) as IHealthCheckInvariant

  /**
   * ReceiverOIF is registered on chain but ABSENT from the deploy log (the mainnet/base state);
   * its EXECUTOR() getter returns `boundExecutor`.
   */
  function makeBindingCtx(boundExecutor: string): IHealthCheckContext {
    const ctx = makeCtx()
    return Object.assign(ctx, {
      diamondAddress: DIAMOND,
      deployedContracts: { Executor: EXECUTOR },
      publicClient: {
        readContract: async ({
          functionName,
          args,
        }: {
          functionName: string
          args?: [string]
        }) => {
          if (functionName === 'getPeripheryContract')
            return args?.[0] === 'ReceiverOIF' ? RECEIVER : ZERO
          return boundExecutor
        },
      },
    } as unknown as IHealthCheckContext)
  }

  it('checks a receiver that the deploy log does not know about', async () => {
    const ctx = makeBindingCtx(OTHER)

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverOIF')
    expect(ctx.errors[0]).toContain('expected deployed Executor')
  })

  it('passes when the registry-resolved receiver is bound to the deployed Executor', async () => {
    const ctx = makeBindingCtx(EXECUTOR)

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
  })
})

describe('receiver-owner covers bridge-specific receivers', () => {
  const RECEIVER = '0x2222222222222222222222222222222222222222'
  const REFUND = '0x4444444444444444444444444444444444444444'
  const OTHER = '0x5555555555555555555555555555555555555555'
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const ZERO = '0x0000000000000000000000000000000000000000'

  const invariant = HEALTH_CHECK_INVARIANTS.find(
    (i) => i.name === 'receiver-owner'
  ) as IHealthCheckInvariant

  /** ReceiverOIF registered on chain only (not in the deploy log); owner() returns `owner`. */
  function makeOwnerCtx(owner: string): IHealthCheckContext {
    const ctx = makeCtx()
    return Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: REFUND,
      deployedContracts: {},
      publicClient: {
        readContract: async ({
          functionName,
          args,
        }: {
          functionName: string
          args?: [string]
        }) => {
          if (functionName === 'getPeripheryContract')
            return args?.[0] === 'ReceiverOIF' ? RECEIVER : ZERO
          return owner
        },
      },
    } as unknown as IHealthCheckContext)
  }

  it('errors when a registry-resolved receiver has the wrong owner', async () => {
    const ctx = makeOwnerCtx(OTHER)

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverOIF')
  })

  it('passes when the owner is the refund wallet', async () => {
    const ctx = makeOwnerCtx(REFUND)

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
  })
})

describe('immutable-bindings-match-config invariant', () => {
  const RECEIVER = '0x2222222222222222222222222222222222222222'
  const OTHER = '0x5555555555555555555555555555555555555555'
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const ZERO = '0x0000000000000000000000000000000000000000'

  const invariant = HEALTH_CHECK_INVARIANTS.find(
    (i) => i.name === 'immutable-bindings-match-config'
  ) as IHealthCheckInvariant

  // The real expected value for mainnet from config/across.json, via the same collector the
  // invariant uses - so the test asserts the wiring, not a copy of the config.
  const expectedSpokepool = collectImmutableBindingChecks(
    'mainnet',
    'production'
  ).find((c) => c.contractName === 'ReceiverAcrossV4')?.expectedAddress

  /** Only ReceiverAcrossV4 present (via deploy log); SPOKEPOOL() returns `spokepool`. */
  function makeBindingsCtx(spokepool: string): IHealthCheckContext {
    const ctx = makeCtx()
    return Object.assign(ctx, {
      networkLower: 'mainnet',
      diamondAddress: DIAMOND,
      deployedContracts: { ReceiverAcrossV4: RECEIVER },
      // Non-empty so the missing-facet-list guard does not skip the invariant.
      onChainFacets: [{ address: '0x9999', selectors: ['0xffffffff'] }],
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === 'getPeripheryContract') return ZERO
          return spokepool
        },
      },
    } as unknown as IHealthCheckContext)
  }

  it('skips with a warning (never the deploy-log fallback) when the facet list is unavailable', async () => {
    const reads: string[] = []
    const ctx = makeBindingsCtx(OTHER)
    Object.assign(ctx, {
      onChainFacets: [],
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => {
          reads.push(functionName)
          return ZERO
        },
      },
    })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.some((w) => w.includes('facet list unavailable'))).toBe(
      true
    )
    expect(reads).toEqual([])
  })

  it('mainnet has an across.json spokepool entry (test precondition)', () => {
    expect(expectedSpokepool).toBeTruthy()
  })

  it('passes when the on-chain binding matches config', async () => {
    const ctx = makeBindingsCtx(expectedSpokepool as string)

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
  })

  it('errors when the on-chain binding differs from config', async () => {
    const ctx = makeBindingsCtx(OTHER)

    await invariant.run(ctx)

    expect(ctx.errors).toHaveLength(1)
    expect(ctx.errors[0]).toContain('ReceiverAcrossV4.SPOKEPOOL()')
    expect(ctx.errors[0]).toContain('across.json')
  })

  it('warns (not errors) when config has no value for the network', async () => {
    const ctx = makeBindingsCtx(OTHER)
    Object.assign(ctx, { networkLower: 'nonexistentchain' })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(ctx.warnings.some((w) => w.includes('cannot verify'))).toBe(true)
  })

  it('runs in the on-chain-facets phase (facet-typed entries resolve from the diamond)', () => {
    expect(invariant.readsOnChainFacets).toBe(true)
  })

  const artifactsBuilt = existsSync(
    resolve(process.cwd(), 'out', 'MayanFacet.sol', 'MayanFacet.json')
  )

  it.skipIf(!artifactsBuilt)(
    'resolves a facet-typed entry from the diamond selector map, not the periphery registry',
    async () => {
      const FACET = '0x7777777777777777777777777777777777777777'
      const expectedMayan = collectImmutableBindingChecks(
        'mainnet',
        'production'
      ).find((c) => c.contractName === 'MayanFacet')?.expectedAddress
      expect(expectedMayan).toBeTruthy()

      // Assert the loader worked before using its result: a failed excludes parse returns
      // null, and a null selector list would fail inside identifyCoupledFacetsOnChain with
      // a message that hides the real cause.
      const mayanSelectors = loadFacetRegisteredSelectors('MayanFacet')
      expect(mayanSelectors).not.toBeNull()

      const registryQueries: string[] = []
      const ctx = makeCtx()
      Object.assign(ctx, {
        networkLower: 'mainnet',
        diamondAddress: DIAMOND,
        // Deploy log deliberately points the facet name at a WRONG address: registry-first
        // resolution through the log would read the getter there and pass on OTHER.
        deployedContracts: { MayanFacet: OTHER },
        onChainFacets: [
          {
            address: FACET,
            selectors: mayanSelectors,
          },
        ],
        publicClient: {
          readContract: async ({
            address,
            functionName,
            args,
          }: {
            address: string
            functionName: string
            args?: [string]
          }) => {
            if (functionName === 'getPeripheryContract') {
              registryQueries.push(args?.[0] as string)
              return ZERO
            }
            if (functionName === 'MAYAN')
              return address === FACET ? expectedMayan : OTHER
            return OTHER
          },
        },
      } as unknown as IHealthCheckContext)

      await invariant.run(ctx)

      expect(ctx.errors.filter((e) => e.includes('MayanFacet'))).toEqual([])
      expect(registryQueries).not.toContain('MayanFacet')
    }
  )
})

describe('receiver checks continue past a single failing read', () => {
  const RECEIVER_A = '0x2222222222222222222222222222222222222222'
  const RECEIVER_B = '0x6666666666666666666666666666666666666666'
  const REFUND = '0x4444444444444444444444444444444444444444'
  const EXECUTOR = '0x4444444444444444444444444444444444444444'
  const OTHER = '0x5555555555555555555555555555555555555555'
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const ZERO = '0x0000000000000000000000000000000000000000'

  /**
   * ReceiverOIF and ReceiverStargateV2 both registered; every non-registry read against
   * ReceiverOIF's address throws (a flaky RPC), reads against ReceiverStargateV2 return `value`.
   */
  function makeFlakyCtx(value: string): IHealthCheckContext {
    const ctx = makeCtx()
    return Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: REFUND,
      deployedContracts: { Executor: EXECUTOR },
      publicClient: {
        readContract: async ({
          address,
          functionName,
          args,
        }: {
          address: string
          functionName: string
          args?: [string]
        }) => {
          if (functionName === 'getPeripheryContract') {
            if (args?.[0] === 'ReceiverOIF') return RECEIVER_A
            if (args?.[0] === 'ReceiverStargateV2') return RECEIVER_B
            return ZERO
          }
          if (address === RECEIVER_A) throw new Error('rpc boom')
          return value
        },
      },
    } as unknown as IHealthCheckContext)
  }

  it('receiver-owner warns on the failing receiver and still checks the rest', async () => {
    const invariant = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-owner'
    ) as IHealthCheckInvariant
    const ctx = makeFlakyCtx(OTHER)

    await invariant.run(ctx)

    expect(
      ctx.warnings.some(
        (w) => w.includes('ReceiverOIF') && w.includes('rpc boom')
      )
    ).toBe(true)
    // ReceiverStargateV2 comes AFTER the failing receiver: an error for it proves the loop
    // survived the throw instead of abandoning the remaining receivers.
    expect(ctx.errors.some((e) => e.includes('ReceiverStargateV2'))).toBe(true)
  })

  it('receiver-executor-binding warns on the failing receiver and still checks the rest', async () => {
    const invariant = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-executor-binding'
    ) as IHealthCheckInvariant
    const ctx = makeFlakyCtx(OTHER)

    await invariant.run(ctx)

    expect(
      ctx.warnings.some(
        (w) => w.includes('ReceiverOIF') && w.includes('rpc boom')
      )
    ).toBe(true)
    expect(ctx.errors.some((e) => e.includes('ReceiverStargateV2'))).toBe(true)
  })
})

describe('periphery registry read cache', () => {
  const RECEIVER = '0x2222222222222222222222222222222222222222'
  const EXECUTOR = '0x4444444444444444444444444444444444444444'
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const ZERO = '0x0000000000000000000000000000000000000000'

  it('reads each registry name at most once across invariants sharing a ctx', async () => {
    const registryQueries: string[] = []
    const ctx = makeCtx()
    Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: EXECUTOR,
      deployedContracts: { Executor: EXECUTOR },
      publicClient: {
        readContract: async ({
          functionName,
          args,
        }: {
          functionName: string
          args?: [string]
        }) => {
          if (functionName === 'getPeripheryContract') {
            registryQueries.push(args?.[0] as string)
            return args?.[0] === 'ReceiverOIF' ? RECEIVER : ZERO
          }
          return EXECUTOR
        },
      },
    } as unknown as IHealthCheckContext)

    const binding = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-executor-binding'
    ) as IHealthCheckInvariant
    const owner = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-owner'
    ) as IHealthCheckInvariant

    await binding.run(ctx)
    await owner.run(ctx)

    const counts = registryQueries.reduce<Record<string, number>>(
      (acc, name) => ({ ...acc, [name]: (acc[name] ?? 0) + 1 }),
      {}
    )
    for (const [name, count] of Object.entries(counts))
      expect({ name, count }).toEqual({ name, count: 1 })
  })

  it('re-verify clears the cache so a successful-but-stale read is not replayed', async () => {
    const RECEIVER = '0x2222222222222222222222222222222222222222'
    const OTHER = '0x5555555555555555555555555555555555555555'
    let oifReads = 0
    const ctx = makeCtx()
    Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: EXECUTOR,
      deployedContracts: {},
      publicClient: {
        readContract: async ({
          functionName,
          args,
        }: {
          functionName: string
          args?: [string]
        }) => {
          if (functionName === 'getPeripheryContract') {
            if (args?.[0] === 'ReceiverOIF') {
              oifReads++
              // A lagging node serves a stale registration once; a fresh read sees reality.
              return oifReads === 1 ? RECEIVER : ZERO
            }
            return ZERO
          }
          return OTHER
        },
      },
    } as unknown as IHealthCheckContext)

    const owner = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-owner'
    ) as IHealthCheckInvariant
    await runHealthCheckInvariants(ctx, [owner])

    expect(oifReads).toBe(2)
    expect(ctx.errors).toEqual([])
  })

  it('does not cache a failed read (the retry hits the RPC again)', async () => {
    let calls = 0
    const ctx = makeCtx()
    Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: EXECUTOR,
      deployedContracts: {},
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === 'getPeripheryContract') {
            calls++
            if (calls === 1) throw new Error('transient')
            return ZERO
          }
          return EXECUTOR
        },
      },
    } as unknown as IHealthCheckContext)

    const owner = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-owner'
    ) as IHealthCheckInvariant

    await owner.run(ctx)
    const callsAfterFirst = calls
    await owner.run(ctx)

    expect(calls).toBeGreaterThan(callsAfterFirst)
  })
})

describe('re-verify uses a private cache without disturbing concurrent invariants', () => {
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const EXECUTOR = '0x4444444444444444444444444444444444444444'
  const ZERO = '0x0000000000000000000000000000000000000000'

  it('leaves a sibling invariant cache entry intact while it re-verifies', async () => {
    // The failing invariant's re-verify must not evict entries a concurrently running invariant
    // already holds: clearing the SHARED map would make siblings re-read during the very RPC
    // degradation that triggered the retry.
    const ctx = makeCtx()
    Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: EXECUTOR,
      deployedContracts: {},
      publicClient: {
        readContract: async () => ZERO,
      },
    } as unknown as IHealthCheckContext)

    const sharedCache = ctx.peripheryRegistryCache
    const sentinel = Promise.resolve(EXECUTOR as `0x${string}`)
    sharedCache.set('SentinelContract', sentinel)

    await runHealthCheckInvariants(ctx, [
      inv('always-fails', async (c) => c.logError('persistent drift')),
    ])

    expect(sharedCache.get('SentinelContract')).toBe(sentinel)
  })

  it('re-reads every name on the re-verify instead of replaying the shared cache', async () => {
    // The other half of the contract: a stale cached SUCCESS must not survive into the retry,
    // or re-verification cannot clear a transient wrong read.
    const ctx = makeCtx()
    Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: EXECUTOR,
      deployedContracts: {},
      publicClient: { readContract: async () => ZERO },
    } as unknown as IHealthCheckContext)
    // Seed a stale success: the RPC truth is ZERO, the cache claims a live receiver.
    ctx.peripheryRegistryCache.set(
      'ReceiverOIF',
      Promise.resolve(EXECUTOR as `0x${string}`)
    )

    const owner = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-owner'
    ) as IHealthCheckInvariant
    await runHealthCheckInvariants(ctx, [
      owner,
      inv('force-reverify', async (c) => c.logError('drift')),
    ])

    // The retry re-read ReceiverOIF from the RPC (ZERO => absent), so the seeded stale address
    // produced no owner error.
    expect(ctx.errors.filter((e) => e.includes('ReceiverOIF'))).toEqual([])
  })
})

describe('periphery-registered survives a single failing registry read', () => {
  const EXECUTOR = '0x4444444444444444444444444444444444444444'
  const TOKEN_WRAPPER = '0x6666666666666666666666666666666666666666'
  const DIAMOND = '0x3333333333333333333333333333333333333333'

  /** Executor registered + logged; TokenWrapper's own registry read fails. */
  function makeCtxWith(
    deployedContracts: Record<string, string>
  ): IHealthCheckContext {
    const ctx = makeCtx()
    return Object.assign(ctx, {
      diamondAddress: DIAMOND,
      targetState: {
        testnet1: {
          production: { LiFiDiamond: { Executor: {}, TokenWrapper: {} } },
        },
      },
      globalConfig: { whitelistPeripheryFunctions: {} },
      deployedContracts,
      publicClient: {
        readContract: async ({ args }: { args?: [string] }) => {
          if (args?.[0] === 'TokenWrapper') throw new Error('rpc boom')
          return EXECUTOR
        },
      },
    } as unknown as IHealthCheckContext)
  }

  const invariant = HEALTH_CHECK_INVARIANTS.find(
    (i) => i.name === 'periphery-registered'
  ) as IHealthCheckInvariant

  it('still errors on a not-deployed contract whose registry read failed', async () => {
    // "Not deployed" is decidable from the deploy log alone, so a flaky read must not mask it.
    const ctx = makeCtxWith({ Executor: EXECUTOR })

    await invariant.run(ctx)

    expect(
      ctx.errors.some(
        (e) => e.includes('TokenWrapper') && e.includes('not deployed')
      )
    ).toBe(true)
  })

  it('warns instead of throwing on a malformed deploy-log address', async () => {
    // Malformed entry on the name whose read SUCCEEDS, so the code reaches the address parse
    // rather than skipping it as unresolved.
    const ctx = makeCtxWith({
      Executor: '0x12NOT_AN_ADDRESS',
      TokenWrapper: TOKEN_WRAPPER,
    })

    await invariant.run(ctx)

    expect(ctx.errors).toEqual([])
    expect(
      ctx.warnings.some(
        (w) => w.includes('Executor') && w.includes('not a valid address')
      )
    ).toBe(true)
  })

  it('warns on the failing name, judges the rest, and never flags the failed one unregistered', async () => {
    const ctx = makeCtx()
    Object.assign(ctx, {
      diamondAddress: DIAMOND,
      targetState: {
        testnet1: {
          production: { LiFiDiamond: { Executor: {}, TokenWrapper: {} } },
        },
      },
      globalConfig: { whitelistPeripheryFunctions: {} },
      deployedContracts: { Executor: EXECUTOR, TokenWrapper: TOKEN_WRAPPER },
      publicClient: {
        readContract: async ({ args }: { args?: [string] }) => {
          if (args?.[0] === 'Executor') throw new Error('rpc boom')
          return TOKEN_WRAPPER
        },
      },
    } as unknown as IHealthCheckContext)

    const invariant = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'periphery-registered'
    ) as IHealthCheckInvariant
    await invariant.run(ctx)

    expect(
      ctx.warnings.some((w) => w.includes('Executor') && w.includes('rpc boom'))
    ).toBe(true)
    expect(ctx.errors).toEqual([])
  })
})

describe('receiver loops survive a malformed deploy-log address', () => {
  const RECEIVER = '0x2222222222222222222222222222222222222222'
  const REFUND = '0x4444444444444444444444444444444444444444'
  const OTHER = '0x5555555555555555555555555555555555555555'
  const DIAMOND = '0x3333333333333333333333333333333333333333'
  const ZERO = '0x0000000000000000000000000000000000000000'

  it('warns on the invalid entry and still checks the remaining receivers', async () => {
    const ctx = makeCtx()
    Object.assign(ctx, {
      diamondAddress: DIAMOND,
      refundWallet: REFUND,
      // Registry misses ReceiverAcrossV4 -> fallback hits this truncated hand-edited entry.
      deployedContracts: { ReceiverAcrossV4: '0x1234NOT_AN_ADDRESS' },
      publicClient: {
        readContract: async ({
          functionName,
          args,
        }: {
          functionName: string
          args?: [string]
        }) => {
          if (functionName === 'getPeripheryContract')
            return args?.[0] === 'ReceiverOIF' ? RECEIVER : ZERO
          return OTHER
        },
      },
    } as unknown as IHealthCheckContext)

    const owner = HEALTH_CHECK_INVARIANTS.find(
      (i) => i.name === 'receiver-owner'
    ) as IHealthCheckInvariant
    await owner.run(ctx)

    expect(ctx.warnings.some((w) => w.includes('not a valid address'))).toBe(
      true
    )
    // ReceiverOIF comes after ReceiverAcrossV4 in the getter list: its error proves the loop
    // survived the malformed entry.
    expect(ctx.errors.some((e) => e.includes('ReceiverOIF'))).toBe(true)
  })
})
