import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  evaluateFacetPeripheryCouplings,
  getFacetPeripheryCouplings,
  identifyCoupledFacetsOnChain,
  isValidFacetName,
  loadFacetRegisteredSelectors,
  loadFacetSelectorsFromArtifact,
  parseUpdateScriptExcludes,
  resolveLiveFacets,
  type TFacetPeripheryCouplings,
} from './facetPeripheryCouplings'

const COUPLINGS: TFacetPeripheryCouplings = {
  AcrossFacetV4: { requiresAnyOf: ['ReceiverAcrossV4'] },
  AcrossFacetPackedV4: { requiresAnyOf: ['ReceiverAcrossV4'] },
  ChainflipFacet: {
    requiresAnyOf: ['ReceiverChainflip'],
    notRequiredOn: { SomeChain: 'Chainflip is source-only there (EXSC-000)' },
  },
  LiFiIntentEscrowFacetV2: { requiresAnyOf: ['ReceiverOIF'] },
}

describe('evaluateFacetPeripheryCouplings', () => {
  it('requires the companion when a coupled facet is present', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4'],
      'mainnet',
      COUPLINGS
    )

    expect(skipped).toEqual([])
    expect(required).toEqual([
      { triggeredBy: ['AcrossFacetV4'], requiresAnyOf: ['ReceiverAcrossV4'] },
    ])
  })

  it('merges facets that need the same companion into one requirement', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetPackedV4'],
      'mainnet',
      COUPLINGS
    )

    expect(required).toHaveLength(1)
    expect(required[0]?.triggeredBy).toEqual([
      'AcrossFacetPackedV4',
      'AcrossFacetV4',
    ])
  })

  it('keeps facets with different companions as separate requirements', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'LiFiIntentEscrowFacetV2'],
      'mainnet',
      COUPLINGS
    )

    expect(required.map((r) => r.requiresAnyOf.join())).toEqual([
      'ReceiverAcrossV4',
      'ReceiverOIF',
    ])
  })

  it('ignores facets with no declared coupling', () => {
    expect(
      evaluateFacetPeripheryCouplings(
        ['GenericSwapFacetV3'],
        'mainnet',
        COUPLINGS
      )
    ).toEqual({ required: [], skipped: [] })
  })

  it('deduplicates a facet listed twice', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetV4'],
      'mainnet',
      COUPLINGS
    )

    expect(required[0]?.triggeredBy).toEqual(['AcrossFacetV4'])
  })

  it('skips a facet carved out for this network, case-insensitively', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'somechain',
      COUPLINGS
    )

    expect(required).toEqual([])
    expect(skipped).toEqual([
      {
        facet: 'ChainflipFacet',
        requiresAnyOf: ['ReceiverChainflip'],
        reason: 'Chainflip is source-only there (EXSC-000)',
      },
    ])
  })

  it('still requires a carved-out facet on other networks', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'mainnet',
      COUPLINGS
    )

    expect(skipped).toEqual([])
    expect(required[0]?.requiresAnyOf).toEqual(['ReceiverChainflip'])
  })

  it('treats a declaration without requiresAnyOf as inert rather than throwing', () => {
    expect(
      evaluateFacetPeripheryCouplings(['AcrossFacetV4'], 'mainnet', {
        AcrossFacetV4: {} as TFacetPeripheryCouplings[string],
      })
    ).toEqual({ required: [], skipped: [] })
  })
})

describe('facetPeripheryCouplings registry in config/global.json', () => {
  const registry = getFacetPeripheryCouplings()

  it('is non-empty', () => {
    expect(Object.keys(registry).length).toBeGreaterThan(0)
  })

  it('keys are real facets and values are real periphery contracts', () => {
    for (const [facet, declaration] of Object.entries(registry)) {
      expect(
        Bun.file(`src/Facets/${facet}.sol`).size,
        `src/Facets/${facet}.sol must exist`
      ).toBeGreaterThan(0)

      expect(declaration.requiresAnyOf.length).toBeGreaterThan(0)
      for (const periphery of declaration.requiresAnyOf)
        expect(
          Bun.file(`src/Periphery/${periphery}.sol`).size,
          `${facet}: src/Periphery/${periphery}.sol must exist`
        ).toBeGreaterThan(0)
    }
  })

  it('gives every per-network carve-out a non-empty reason', () => {
    for (const declaration of Object.values(registry))
      for (const reason of Object.values(declaration.notRequiredOn ?? {}))
        expect(reason.length).toBeGreaterThan(0)
  })

  it('every registry key resolves to a build artifact with selectors (selector identity is viable)', () => {
    // resolveLiveFacets identifies coupled facets by their compiled selectors, so a registry key
    // that has no loadable artifact would silently fall back to deploy-log-only identity. Guard it.
    for (const facet of Object.keys(registry)) {
      const selectors = loadFacetSelectorsFromArtifact(facet)
      // Skipped, not failed, when out/ is absent (the TS unit-test job runs without forge build).
      if (selectors === null) continue
      expect(
        selectors.length,
        `${facet}: build artifact must expose at least one selector`
      ).toBeGreaterThan(0)
    }
  })

  it('covers every facet of an already-coupled family (guards a forgotten new variant)', () => {
    // The registry is an allowlist, so a new family member (e.g. a future AcrossFacetV5) would
    // otherwise be silently unchecked. Any facet sharing a coupled facet's bridge prefix must
    // itself be coupled — deprecated facets are the documented exemptions: AcrossFacet, and
    // LiFiIntentEscrowFacet (V1, superseded by V2; only testnets still run V1 without V2 and
    // the coupling invariant is production-scoped).
    const DEPRECATED_EXEMPT = ['AcrossFacet', 'LiFiIntentEscrowFacet']
    const families = ['Across', 'Chainflip', 'LiFiIntentEscrow', 'Stargate']
    const facetsOnDisk = [...new Bun.Glob('*.sol').scanSync('src/Facets')].map(
      (f) => f.replace(/\.sol$/, '')
    )
    // Guard the guard: a broken glob would make the assertion below vacuously pass.
    expect(facetsOnDisk.length).toBeGreaterThan(20)

    const uncovered = facetsOnDisk.filter(
      (facet) =>
        families.some((family) => facet.startsWith(family)) &&
        !registry[facet] &&
        !DEPRECATED_EXEMPT.includes(facet)
    )

    expect(uncovered).toEqual([])
  })
})

// Real selector values from the compiled Across V4 artifacts (out/<Facet>.sol/<Facet>.json,
// methodIdentifiers). Snapshotted here so the suite stays hermetic (the TS test job has no
// Foundry build) while still exercising the shape production data actually has: registration
// EXCLUDES shared selectors (SPOKEPOOL(), WRAPPED_NATIVE(), ownership functions), so the
// on-chain set is a strict subset of the artifact.
const ACROSS_V4_ARTIFACT = [
  '0xe796cd98', // ACROSS_CHAIN_ID_SOLANA()
  '0xf97136af', // MULTIPLIER_BASE()
  '0xf6503992', // SPOKEPOOL()            — excluded by UpdateAcrossFacetV4.s.sol
  '0xd999984d', // WRAPPED_NATIVE()       — excluded by UpdateAcrossFacetV4.s.sol
  '0xa1f1ce43', // startBridgeTokensViaAcrossV4(...)
  '0x1794958f', // swapAndStartBridgeTokensViaAcrossV4(...)
]
const ACROSS_V4_REGISTERED = [
  '0xe796cd98',
  '0xf97136af',
  '0xa1f1ce43',
  '0x1794958f',
]
const ACROSS_V4_SWAP_REGISTERED = [
  '0x6a90d66e', // startBridgeTokensViaAcrossV4Swap(...)
  '0x9b054bc4', // swapAndStartBridgeTokensViaAcrossV4Swap(...)
]

describe('identifyCoupledFacetsOnChain', () => {
  // Injected loader with REGISTERED (post-exclusion) selector sets — what
  // loadFacetRegisteredSelectors returns in production.
  const REGISTERED: Record<string, string[]> = {
    AcrossFacetV4: ACROSS_V4_REGISTERED,
    AcrossV4SwapFacet: ACROSS_V4_SWAP_REGISTERED,
    StargateFacetV2: ['0xbbbb0001'],
  }
  const load = (name: string) => REGISTERED[name] ?? null

  it('identifies a facet from its post-exclusion on-chain set, ignoring the deploy log', () => {
    // The on-chain set is what UpdateAcrossFacetV4.s.sol actually cuts: the artifact minus
    // SPOKEPOOL()/WRAPPED_NATIVE(). Matching must succeed on exactly this shape (EXSC-684
    // round 3: full-artifact matching could never fire for any facet cut with excludes).
    const { live, unresolved, addressByName } = identifyCoupledFacetsOnChain(
      [
        { address: '0xAcrossV4', selectors: ACROSS_V4_REGISTERED },
        { address: '0xSwap', selectors: ACROSS_V4_SWAP_REGISTERED },
      ],
      ['AcrossFacetV4', 'AcrossV4SwapFacet', 'StargateFacetV2'],
      load
    )

    expect(live).toEqual(['AcrossFacetV4', 'AcrossV4SwapFacet'])
    expect(unresolved).toEqual([])
    expect(addressByName).toEqual({
      AcrossFacetV4: '0xAcrossV4',
      AcrossV4SwapFacet: '0xSwap',
    })
  })

  it('does not identify a facet from selectors it shares with a sibling', () => {
    // ACROSS_CHAIN_ID_SOLANA()/MULTIPLIER_BASE() exist in both AcrossFacetV4 and
    // AcrossV4SwapFacet. An on-chain facet registering only those two must not be claimed by
    // either candidate (their registered sets contain selectors this facet lacks).
    const { live } = identifyCoupledFacetsOnChain(
      [{ address: '0xdead', selectors: ['0xe796cd98', '0xf97136af'] }],
      ['AcrossFacetV4', 'AcrossV4SwapFacet'],
      load
    )

    expect(live).toEqual([])
  })

  it('is case-insensitive on both selector sides', () => {
    const { live } = identifyCoupledFacetsOnChain(
      [
        {
          address: '0xdead',
          selectors: ACROSS_V4_REGISTERED.map((s) => s.toUpperCase()),
        },
      ],
      ['AcrossFacetV4'],
      load
    )

    expect(live).toEqual(['AcrossFacetV4'])
  })

  it('refuses a path-traversal facet name rather than reading outside out/', () => {
    // Names come from config/global.json today, but harden the read regardless (mirrors readDeployLog).
    expect(isValidFacetName('AcrossFacetV4')).toBe(true)
    expect(isValidFacetName('../../.env')).toBe(false)
    expect(loadFacetSelectorsFromArtifact('../../../etc/passwd')).toBeNull()
    expect(loadFacetRegisteredSelectors('../../../etc/passwd')).toBeNull()
  })

  it('reports a facet whose registered selectors cannot be determined as unresolved, not absent', () => {
    const { live, unresolved } = identifyCoupledFacetsOnChain(
      [{ address: '0xdead', selectors: ['0xffffffff'] }],
      ['UnknownFacet'],
      load
    )

    expect(live).toEqual([])
    expect(unresolved).toEqual(['UnknownFacet'])
  })

  it('treats an empty registered set as unresolved, never as a vacuous match-all', () => {
    const { live, unresolved } = identifyCoupledFacetsOnChain(
      [{ address: '0xdead', selectors: ['0xffffffff'] }],
      ['EmptyFacet'],
      () => []
    )

    expect(live).toEqual([])
    expect(unresolved).toEqual(['EmptyFacet'])
  })
})

describe('parseUpdateScriptExcludes', () => {
  // Real update scripts, read from the repo — the parser must handle every exclude shape that
  // actually exists, not a synthetic idealization of them.
  const readScript = (name: string) =>
    readFileSync(
      resolve(process.cwd(), 'script', 'deploy', 'facets', name),
      'utf8'
    )

  it('parses name-based excludes from the real UpdateAcrossFacetV4.s.sol', () => {
    const parsed = parseUpdateScriptExcludes(
      readScript('UpdateAcrossFacetV4.s.sol')
    )

    expect(parsed).toEqual({
      functionNames: ['SPOKEPOOL', 'WRAPPED_NATIVE'],
      literalSelectors: [],
    })
  })

  it('parses all 9 excludes from the real UpdateAcrossFacetPackedV4.s.sol', () => {
    const parsed = parseUpdateScriptExcludes(
      readScript('UpdateAcrossFacetPackedV4.s.sol')
    )

    expect(parsed?.functionNames).toEqual([
      'cancelOwnershipTransfer',
      'transferOwnership',
      'confirmOwnershipTransfer',
      'owner',
      'pendingOwner',
      'setApprovalForBridge',
      'executeCallAndWithdraw',
      'SPOKEPOOL',
      'WRAPPED_NATIVE',
    ])
  })

  it('parses literal-selector excludes from the real UpdateHopFacetPacked.s.sol', () => {
    const parsed = parseUpdateScriptExcludes(
      readScript('UpdateHopFacetPacked.s.sol')
    )

    expect(parsed).toEqual({
      functionNames: [],
      literalSelectors: [
        '0x23452b9c',
        '0x7200b829',
        '0x8da5cb5b',
        '0xe30c3978',
        '0xf2fde38b',
      ],
    })
  })

  it('parses the empty-excludes shape from the real UpdateChainflipFacet.s.sol', () => {
    const parsed = parseUpdateScriptExcludes(
      readScript('UpdateChainflipFacet.s.sol')
    )

    expect(parsed).toEqual({ functionNames: [], literalSelectors: [] })
  })

  it('returns empty excludes when the script has no getExcludes override', () => {
    expect(
      parseUpdateScriptExcludes('contract DeployScript { function run() {} }')
    ).toEqual({ functionNames: [], literalSelectors: [] })
  })

  it('returns null when assignments do not add up to the declared array size', () => {
    // An unrecognized assignment shape must poison the whole parse: a silently incomplete
    // exclude list would produce a registered set that never matches on chain.
    const source = `
      function getExcludes() internal pure override returns (bytes4[] memory) {
        bytes4[] memory excludes = new bytes4[](2);
        excludes[0] = facet.SPOKEPOOL.selector;
        excludes[1] = computeSelector("WRAPPED_NATIVE()");
        return excludes;
      }`

    expect(parseUpdateScriptExcludes(source)).toBeNull()
  })

  it('ignores .selector references outside getExcludes (init calldata)', () => {
    const source = `
      contract DeployScript {
        function getExcludes() internal pure override returns (bytes4[] memory) {
          bytes4[] memory excludes = new bytes4[](1);
          excludes[0] = HopFacet.initHop.selector;
          return excludes;
        }
        function run() public {
          bytes memory callData = abi.encodeWithSelector(
            HopFacet.someOtherInit.selector, cfg
          );
        }
      }`

    expect(parseUpdateScriptExcludes(source)).toEqual({
      functionNames: ['initHop'],
      literalSelectors: [],
    })
  })
})

describe('loadFacetRegisteredSelectors zksync-variant handling', () => {
  // A synthetic repo root: the loader takes the root as a parameter, so the zksync divergence
  // branch is exercised without depending on which real scripts happen to agree today.
  function makeRepo(canonical: string | null, zksync: string | null): string {
    const root = mkdtempSync(join(tmpdir(), 'coupling-zksync-'))
    mkdirSync(join(root, 'out', 'FooFacet.sol'), { recursive: true })
    writeFileSync(
      join(root, 'out', 'FooFacet.sol', 'FooFacet.json'),
      JSON.stringify({
        methodIdentifiers: {
          'SPOKEPOOL()': 'f6503992',
          'bridge()': 'aaaaaaaa',
          'swap()': 'bbbbbbbb',
        },
      })
    )
    if (canonical !== null) {
      mkdirSync(join(root, 'script', 'deploy', 'facets'), { recursive: true })
      writeFileSync(
        join(root, 'script', 'deploy', 'facets', 'UpdateFooFacet.s.sol'),
        canonical
      )
    }
    if (zksync !== null) {
      mkdirSync(join(root, 'script', 'deploy', 'zksync'), { recursive: true })
      writeFileSync(
        join(root, 'script', 'deploy', 'zksync', 'UpdateFooFacet.zksync.s.sol'),
        zksync
      )
    }
    return root
  }

  const EXCLUDE_SPOKEPOOL = `
      contract DeployScript {
        function getExcludes() internal view override returns (bytes4[] memory) {
          bytes4[] memory excludes = new bytes4[](1);
          excludes[0] = foo.SPOKEPOOL.selector;
          return excludes;
        }
      }`
  const EXCLUDE_SPOKEPOOL_AND_SWAP = `
      contract DeployScript {
        function getExcludes() internal view override returns (bytes4[] memory) {
          bytes4[] memory excludes = new bytes4[](2);
          excludes[0] = foo.SPOKEPOOL.selector;
          excludes[1] = foo.swap.selector;
          return excludes;
        }
      }`

  it('applies the excludes when canonical and zksync agree', () => {
    const root = makeRepo(EXCLUDE_SPOKEPOOL, EXCLUDE_SPOKEPOOL)

    expect(loadFacetRegisteredSelectors('FooFacet', root)?.sort()).toEqual([
      '0xaaaaaaaa',
      '0xbbbbbbbb',
    ])
  })

  it('degrades to unresolved when the zksync excludes diverge from the canonical ones', () => {
    // Two different registration sets exist, so no single network-agnostic answer does.
    const root = makeRepo(EXCLUDE_SPOKEPOOL, EXCLUDE_SPOKEPOOL_AND_SWAP)

    expect(loadFacetRegisteredSelectors('FooFacet', root)).toBeNull()
  })

  it('degrades to unresolved when the zksync script exists but cannot be parsed', () => {
    const unparseable = `
      contract DeployScript {
        function getExcludes() internal view override returns (bytes4[] memory) {
          bytes4[] memory excludes = new bytes4[](1);
          excludes[0] = computeSelector("SPOKEPOOL()");
          return excludes;
        }
      }`
    const root = makeRepo(EXCLUDE_SPOKEPOOL, unparseable)

    expect(loadFacetRegisteredSelectors('FooFacet', root)).toBeNull()
  })

  it('uses the zksync excludes when only a zksync script exists', () => {
    const root = makeRepo(null, EXCLUDE_SPOKEPOOL)

    expect(loadFacetRegisteredSelectors('FooFacet', root)?.sort()).toEqual([
      '0xaaaaaaaa',
      '0xbbbbbbbb',
    ])
  })

  it('returns the full artifact set when neither script exists', () => {
    const root = makeRepo(null, null)

    expect(loadFacetRegisteredSelectors('FooFacet', root)?.sort()).toEqual([
      '0xaaaaaaaa',
      '0xbbbbbbbb',
      '0xf6503992',
    ])
  })
})

describe('loadFacetRegisteredSelectors (real artifacts)', () => {
  // Full-stack identity check against the real build outputs. Runs only where out/ exists —
  // locally and in jobs that ran forge build; the TS-only CI job skips it.
  const artifactsBuilt = existsSync(
    resolve(process.cwd(), 'out', 'AcrossFacetV4.sol', 'AcrossFacetV4.json')
  )

  it.skipIf(!artifactsBuilt)(
    'computes the exact post-exclusion set for AcrossFacetV4 from the real artifact + script',
    () => {
      const registered = loadFacetRegisteredSelectors('AcrossFacetV4')

      expect(registered?.sort()).toEqual([...ACROSS_V4_REGISTERED].sort())
    }
  )

  it.skipIf(!artifactsBuilt)(
    'identifies every coupled Across V4 facet from realistic on-chain sets with the default loader',
    () => {
      // The fire-drill for the whole identity source: real artifacts, real update-script
      // excludes, on-chain sets shaped exactly like a production diamond registration.
      const { live, unresolved } = identifyCoupledFacetsOnChain(
        [
          { address: '0x1', selectors: ACROSS_V4_REGISTERED },
          { address: '0x2', selectors: ACROSS_V4_SWAP_REGISTERED },
        ],
        ['AcrossFacetV4', 'AcrossV4SwapFacet']
      )

      expect(live).toEqual(['AcrossFacetV4', 'AcrossV4SwapFacet'])
      expect(unresolved).toEqual([])
    }
  )

  it.skipIf(!artifactsBuilt)(
    'never returns the full artifact set for a facet whose update script has excludes',
    () => {
      const registered = loadFacetRegisteredSelectors('AcrossFacetV4')

      expect(registered).not.toBeNull()
      expect(registered?.length).toBeLessThan(ACROSS_V4_ARTIFACT.length)
      expect(registered).not.toContain('0xf6503992') // SPOKEPOOL()
      expect(registered).not.toContain('0xd999984d') // WRAPPED_NATIVE()
    }
  )
})

describe('resolveLiveFacets', () => {
  const SELECTORS: Record<string, string[]> = {
    AcrossFacetV4: ['0xaaaa0001'],
  }
  const load = (name: string) => SELECTORS[name] ?? null
  const FACET = '0x1111111111111111111111111111111111111111'

  it('resolves a facet present in the deploy log by name (no selector help needed)', () => {
    const { liveFacets, blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      { AcrossFacetV4: FACET },
      ['AcrossFacetV4'],
      load
    )

    expect(liveFacets).toEqual(['AcrossFacetV4'])
    expect(blindSpotWarning).toBeNull()
  })

  it('closes the gap: a coupled facet absent from the deploy log is caught via selectors', () => {
    // The failure Daniela flagged — facet live on chain, missing from deploys/<network>.json.
    const { liveFacets, blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      {},
      ['AcrossFacetV4'],
      load
    )

    expect(liveFacets).toEqual(['AcrossFacetV4'])
    expect(blindSpotWarning).toBeNull()
  })

  it('warns when an on-chain facet is absent from the log and selectors cannot identify it either', () => {
    const noArtifacts = () => null
    const { liveFacets, blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      {},
      ['AcrossFacetV4'],
      noArtifacts
    )

    expect(liveFacets).toEqual([])
    expect(blindSpotWarning).toContain('could not be determined')
    expect(blindSpotWarning).toContain('AcrossFacetV4')
  })

  it('warns even when only ONE candidate is unresolved (per-facet blind spot, not just no-build)', () => {
    // Unresolvability is per-facet since excludes parsing: one unparseable update script must
    // not hide behind the other candidates resolving fine.
    const oneUnresolved = (name: string) =>
      name === 'AcrossFacetV4' ? ['0xaaaa0001'] : null
    const { blindSpotWarning } = resolveLiveFacets(
      [
        { address: FACET, selectors: ['0xaaaa0001'] },
        {
          address: '0x2222222222222222222222222222222222222222',
          selectors: ['0xdddd0001'],
        },
      ],
      { AcrossFacetV4: FACET },
      ['AcrossFacetV4', 'ChainflipFacet'],
      oneUnresolved
    )

    expect(blindSpotWarning).toContain('ChainflipFacet')
    expect(blindSpotWarning).not.toContain('AcrossFacetV4,')
  })

  it('does not warn about a fully deploy-log-resolved facet even when artifacts are unavailable', () => {
    // No on-chain facet is unaccounted for, so an unresolved candidate cannot be hiding.
    const noArtifacts = () => null
    const { blindSpotWarning } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      { AcrossFacetV4: FACET },
      ['AcrossFacetV4'],
      noArtifacts
    )

    expect(blindSpotWarning).toBeNull()
  })

  it('reports version drift for a log-identified facet whose current selectors match nothing', () => {
    // Deployed build older than HEAD: registered set resolved from the artifact, but the
    // on-chain facet serves different selectors. Coverage rests on the deploy log alone and
    // that must be visible.
    const { liveFacets, versionDriftNotes } = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xbbbb9999'] }],
      { AcrossFacetV4: FACET },
      ['AcrossFacetV4'],
      load
    )

    expect(liveFacets).toEqual(['AcrossFacetV4'])
    expect(versionDriftNotes).toHaveLength(1)
    expect(versionDriftNotes[0]).toContain('AcrossFacetV4')
    expect(versionDriftNotes[0]).toContain('do not match the current artifact')
  })

  it('reports no version drift when the facet matches or is simply absent', () => {
    const matched = resolveLiveFacets(
      [{ address: FACET, selectors: ['0xaaaa0001'] }],
      { AcrossFacetV4: FACET },
      ['AcrossFacetV4'],
      load
    )
    const absent = resolveLiveFacets([], {}, ['AcrossFacetV4'], load)

    expect(matched.versionDriftNotes).toEqual([])
    expect(absent.versionDriftNotes).toEqual([])
  })
})
