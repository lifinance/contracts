import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import {
  evaluateFacetPeripheryCouplings,
  getFacetPeripheryCouplings,
  loadCompiledFacetSelectors,
  resolveLiveFacets,
  type TFacetPeripheryCouplings,
} from './facetPeripheryCouplings'

const COUPLINGS: TFacetPeripheryCouplings = {
  AcrossFacetV4: { requires: 'ReceiverAcrossV4' },
  AcrossFacetPackedV4: { requires: 'ReceiverAcrossV4' },
  ChainflipFacet: {
    requires: 'ReceiverChainflip',
    notRequiredOn: { somechain: 'destination calls not supported (EXSC-000)' },
  },
}

describe('getFacetPeripheryCouplings', () => {
  it('reads the coupling block declared in config/global.json', () => {
    const couplings = getFacetPeripheryCouplings()
    expect(couplings.AcrossFacetV4?.requires).toBe('ReceiverAcrossV4')
  })
})

describe('evaluateFacetPeripheryCouplings', () => {
  it('collapses facets sharing a companion into one requirement', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetPackedV4'],
      'mainnet',
      COUPLINGS
    )
    expect(required).toHaveLength(1)
    expect(required[0]?.companion).toBe('ReceiverAcrossV4')
    expect(required[0]?.triggeredBy).toEqual([
      'AcrossFacetPackedV4',
      'AcrossFacetV4',
    ])
  })

  it('ignores facets that have no declared coupling', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['SomeUnrelatedFacet'],
      'mainnet',
      COUPLINGS
    )
    expect(required).toHaveLength(0)
  })

  it('skips a facet carved out on the current network', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'somechain',
      COUPLINGS
    )
    expect(required).toHaveLength(0)
    expect(skipped).toEqual([
      {
        facet: 'ChainflipFacet',
        companion: 'ReceiverChainflip',
        reason: 'destination calls not supported (EXSC-000)',
      },
    ])
  })

  it('enforces a carved-out facet on other networks', () => {
    const { required, skipped } = evaluateFacetPeripheryCouplings(
      ['ChainflipFacet'],
      'mainnet',
      COUPLINGS
    )
    expect(skipped).toHaveLength(0)
    expect(required[0]?.companion).toBe('ReceiverChainflip')
  })

  it('deduplicates repeated facet names', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4', 'AcrossFacetV4'],
      'mainnet',
      COUPLINGS
    )
    expect(required[0]?.triggeredBy).toEqual(['AcrossFacetV4'])
  })

  it('defaults to the config registry when none is passed', () => {
    const { required } = evaluateFacetPeripheryCouplings(
      ['AcrossFacetV4'],
      'mainnet'
    )
    expect(required[0]?.companion).toBe('ReceiverAcrossV4')
  })
})

describe('resolveLiveFacets', () => {
  const ACROSS_SELECTORS = ['0x11111111', '0x22222222']
  const CHAINFLIP_SELECTORS = ['0x33333333']
  const OWNERSHIP_SELECTORS = ['0x44444444']

  const deployLog = {
    AcrossFacetV4: '0xAAaa000000000000000000000000000000000001',
    ChainflipFacet: '0xCCcc000000000000000000000000000000000003',
    OwnershipFacet: '0xEEee000000000000000000000000000000000005',
  }
  const compiled = {
    AcrossFacetV4: ACROSS_SELECTORS,
    ChainflipFacet: CHAINFLIP_SELECTORS,
    OwnershipFacet: OWNERSHIP_SELECTORS,
  }
  const candidates = ['AcrossFacetV4', 'ChainflipFacet']

  it('identifies a candidate by its deploy-log address', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0xaaaa000000000000000000000000000000000001',
          selectors: ACROSS_SELECTORS,
        },
      ],
      deployLog,
      candidates,
      compiled
    )
    expect(resolved).toEqual(['AcrossFacetV4'])
  })

  it('identifies a candidate absent from the deploy log by its full selector set', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: CHAINFLIP_SELECTORS,
        },
      ],
      { AcrossFacetV4: deployLog.AcrossFacetV4 },
      candidates,
      compiled
    )
    expect(resolved).toEqual(['ChainflipFacet'])
  })

  it('identifies a candidate whose deploy-log address is stale', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: ACROSS_SELECTORS,
        },
      ],
      deployLog,
      candidates,
      compiled
    )
    expect(resolved).toEqual(['AcrossFacetV4'])
  })

  it('identifies a facet registered with only part of its compiled selector set', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: [ACROSS_SELECTORS[0] as string],
        },
      ],
      {},
      candidates,
      compiled
    )
    expect(resolved).toEqual(['AcrossFacetV4'])
  })

  it('refuses to identify a facet whose selectors fit more than one compiled set', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: [ACROSS_SELECTORS[0] as string],
        },
      ],
      {},
      [...candidates, 'AcrossFacetPackedV4'],
      {
        ...compiled,
        AcrossFacetPackedV4: [...ACROSS_SELECTORS, '0x55555555'],
      }
    )
    expect(resolved).toEqual([])
  })

  it('prefers an exact selector-set match over a broader containing one', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: CHAINFLIP_SELECTORS,
        },
      ],
      {},
      candidates,
      {
        ...compiled,
        AcrossFacetV4: [...CHAINFLIP_SELECTORS, '0x66666666'],
      }
    )
    expect(resolved).toEqual(['ChainflipFacet'])
  })

  it('does not identify a facet whose on-chain set is a superset of a compiled set', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: [...CHAINFLIP_SELECTORS, '0xdeadbeef'],
        },
      ],
      {},
      candidates,
      compiled
    )
    expect(resolved).toEqual([])
  })

  it('matches selectors regardless of case, order and 0x prefix', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: ['22222222', '0X11111111'],
        },
      ],
      {},
      candidates,
      compiled
    )
    expect(resolved).toEqual(['AcrossFacetV4'])
  })

  it('does not report an on-chain facet identified by a compiled non-candidate', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: OWNERSHIP_SELECTORS,
        },
      ],
      {},
      candidates,
      compiled
    )
    expect(resolved).toEqual([])
  })

  it('lists a candidate once when both log and selector set identify it', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0xaaaa000000000000000000000000000000000001',
          selectors: ACROSS_SELECTORS,
        },
      ],
      deployLog,
      candidates,
      compiled
    )
    expect(resolved).toEqual(['AcrossFacetV4'])
  })

  it('uses selectors when the deploy log names the address something uncoupled', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: CHAINFLIP_SELECTORS,
        },
      ],
      { RetiredFacet: '0x9999000000000000000000000000000000000099' },
      candidates,
      compiled
    )
    expect(resolved).toEqual(['ChainflipFacet'])
  })

  it('falls back to log-only resolution when no compiled selectors are available', () => {
    const resolved = resolveLiveFacets(
      [
        {
          address: '0xaaaa000000000000000000000000000000000001',
          selectors: ACROSS_SELECTORS,
        },
        {
          address: '0x9999000000000000000000000000000000000099',
          selectors: CHAINFLIP_SELECTORS,
        },
      ],
      deployLog,
      candidates,
      {}
    )
    expect(resolved).toEqual(['AcrossFacetV4'])
  })
})

describe('loadCompiledFacetSelectors', () => {
  function inRepo(build: (root: string) => void, body: () => void): void {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'couplings-')))
    const cwd = process.cwd()
    try {
      build(root)
      process.chdir(root)
      body()
    } finally {
      process.chdir(cwd)
      rmSync(root, { recursive: true, force: true })
    }
  }

  function writeArtifact(
    root: string,
    name: string,
    methodIdentifiers: Record<string, string> | null
  ): void {
    mkdirSync(join(root, 'out', `${name}.sol`), { recursive: true })
    writeFileSync(
      join(root, 'out', `${name}.sol`, `${name}.json`),
      JSON.stringify(methodIdentifiers ? { methodIdentifiers } : {})
    )
  }

  function writeFacetSource(root: string, name: string): void {
    mkdirSync(join(root, 'src', 'Facets'), { recursive: true })
    writeFileSync(join(root, 'src', 'Facets', `${name}.sol`), '')
  }

  it('reads the compiled selector set of every facet source', () => {
    inRepo(
      (root) => {
        writeFacetSource(root, 'FooFacet')
        writeArtifact(root, 'FooFacet', {
          'foo()': 'aabbccdd',
          'bar()': '11223344',
        })
      },
      () => {
        expect(loadCompiledFacetSelectors()).toEqual({
          FooFacet: ['0xaabbccdd', '0x11223344'],
        })
      }
    )
  })

  it('skips a facet whose artifact has not been built', () => {
    inRepo(
      (root) => {
        writeFacetSource(root, 'FooFacet')
        writeFacetSource(root, 'UnbuiltFacet')
        writeArtifact(root, 'FooFacet', { 'foo()': 'aabbccdd' })
      },
      () => {
        expect(Object.keys(loadCompiledFacetSelectors())).toEqual(['FooFacet'])
      }
    )
  })

  it('skips an artifact that carries no method identifiers', () => {
    inRepo(
      (root) => {
        writeFacetSource(root, 'FooFacet')
        writeArtifact(root, 'FooFacet', null)
      },
      () => {
        expect(loadCompiledFacetSelectors()).toEqual({})
      }
    )
  })

  it('survives an unparseable artifact instead of aborting the whole read', () => {
    inRepo(
      (root) => {
        writeFacetSource(root, 'BrokenFacet')
        writeFacetSource(root, 'FooFacet')
        mkdirSync(join(root, 'out', 'BrokenFacet.sol'), { recursive: true })
        writeFileSync(
          join(root, 'out', 'BrokenFacet.sol', 'BrokenFacet.json'),
          '{not json'
        )
        writeArtifact(root, 'FooFacet', { 'foo()': 'aabbccdd' })
      },
      () => {
        expect(Object.keys(loadCompiledFacetSelectors())).toEqual(['FooFacet'])
      }
    )
  })

  it('returns nothing when the repository has no build output', () => {
    inRepo(
      (root) => {
        writeFacetSource(root, 'FooFacet')
      },
      () => {
        expect(loadCompiledFacetSelectors()).toEqual({})
      }
    )
  })

  it('returns nothing when there is no facet source directory', () => {
    inRepo(
      () => undefined,
      () => {
        expect(loadCompiledFacetSelectors()).toEqual({})
      }
    )
  })
})
