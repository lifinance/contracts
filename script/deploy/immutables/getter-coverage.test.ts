/**
 * Tests for the getter-coverage gate.
 *
 * The caller supplies the declarations the AST enumeration would produce, so every branch is
 * decidable without Foundry on the runner. One test reads `src/` itself, to hold the annotations
 * this repo actually carries against the versions its contracts declare.
 */
import { readFileSync } from 'fs'

// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import deployRequirements from '../resources/deployRequirements.json'
import type { IDeployRequirementEntry } from '../shared/immutableBindings'

import {
  collectAnnotatedGetterKeys,
  collectPublicImmutableGetters,
  readGetterExemptions,
  verifyGetterCoverage,
  verifyGetterSinceVersions,
} from './getter-coverage'
import type { IImmutableDeclaration } from './immutable-ast'

const declaration = (
  over: Partial<IImmutableDeclaration> = {}
): IImmutableDeclaration => ({
  file: 'src/Facets/SampleFacet.sol',
  contract: 'SampleFacet',
  line: 20,
  type: 'address',
  visibility: 'public',
  name: 'SPOKEPOOL',
  ...over,
})

describe('collectPublicImmutableGetters', () => {
  it('keeps an address-typed public immutable', () => {
    expect(collectPublicImmutableGetters([declaration()])).toEqual([
      {
        contractName: 'SampleFacet',
        getter: 'SPOKEPOOL',
        solidityType: 'address',
        sourceFile: 'src/Facets/SampleFacet.sol',
      },
    ])
  })

  it('keys on the contract the AST names, not the file basename', () => {
    const [getter] = collectPublicImmutableGetters([
      declaration({
        file: 'src/Facets/Bundle.sol',
        contract: 'SecondFacetInTheSameFile',
      }),
    ])

    expect(getter?.contractName).toBe('SecondFacetInTheSameFile')
  })

  it.each([['contract ISpokePool'], ['address payable']])(
    'keeps a %s immutable — it holds an address',
    (type) => {
      expect(
        collectPublicImmutableGetters([declaration({ type })])
      ).toHaveLength(1)
    }
  )

  it.each([['uint256'], ['bool'], ['bytes32'], ['enum Sample.Kind']])(
    'drops a %s immutable — it cannot hold a counterparty',
    (type) => {
      expect(collectPublicImmutableGetters([declaration({ type })])).toEqual([])
    }
  )

  it.each([['private'], ['internal']])(
    'drops a %s immutable — the compiler generates no getter',
    (visibility) => {
      expect(
        collectPublicImmutableGetters([
          declaration({
            visibility: visibility as IImmutableDeclaration['visibility'],
          }),
        ])
      ).toEqual([])
    }
  )

  it('gates only the deployed trees', () => {
    expect(
      collectPublicImmutableGetters([
        declaration({ file: 'src/Helpers/Helper.sol' }),
        declaration({ file: 'src/Libraries/LibThing.sol' }),
      ])
    ).toEqual([])
  })

  it.each([
    ['src/Facets/A.sol'],
    ['src/Periphery/A.sol'],
    ['src/Security/A.sol'],
  ])('gates %s', (file) => {
    expect(collectPublicImmutableGetters([declaration({ file })])).toHaveLength(
      1
    )
  })
})

describe('verifyGetterCoverage', () => {
  const ANNOTATED = new Set(['SampleFacet.ANNOTATED'])

  it('reports a getter that neither annotation nor exemption covers', () => {
    const errors = verifyGetterCoverage([declaration()], {}, ANNOTATED)

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('SampleFacet.SPOKEPOOL')
    expect(errors[0]).toContain('src/Facets/SampleFacet.sol')
  })

  it('accepts a getter the deploy requirements annotate', () => {
    expect(
      verifyGetterCoverage([declaration({ name: 'ANNOTATED' })], {}, ANNOTATED)
    ).toEqual([])
  })

  it('accepts a getter carrying a recorded exemption', () => {
    expect(
      verifyGetterCoverage(
        [declaration()],
        { 'SampleFacet.SPOKEPOOL': 'a reason' },
        ANNOTATED
      )
    ).toEqual([])
  })

  it('rejects an exemption for a getter that is now annotated', () => {
    const errors = verifyGetterCoverage(
      [declaration({ name: 'ANNOTATED' })],
      { 'SampleFacet.ANNOTATED': 'stale' },
      ANNOTATED
    )

    expect(errors.join('\n')).toContain('exempted but now annotated')
  })

  it('rejects an exemption for a getter no contract declares', () => {
    const errors = verifyGetterCoverage(
      [],
      { 'SampleFacet.GONE': 'stale' },
      ANNOTATED
    )

    expect(errors.join('\n')).toContain('no contract declares it')
  })

  it('rejects an exemption with a blank reason', () => {
    const errors = verifyGetterCoverage(
      [declaration()],
      { 'SampleFacet.SPOKEPOOL': '   ' },
      ANNOTATED
    )

    expect(errors.join('\n')).toContain('no reason given')
  })
})

describe('the repo as it stands', () => {
  it('annotates at least one binding, so the annotation reader is not vacuous', () => {
    expect(
      collectAnnotatedGetterKeys(
        deployRequirements as Parameters<typeof collectAnnotatedGetterKeys>[0]
      ).size
    ).toBeGreaterThan(0)
  })

  it('records exemptions as readable data, every one with a reason', () => {
    const exemptions = readGetterExemptions()

    expect(Object.keys(exemptions).length).toBeGreaterThan(0)
    expect(
      Object.entries(exemptions)
        .filter(([, reason]) => (reason ?? '').trim().length === 0)
        .map(([key]) => key)
    ).toEqual([])
  })
})

describe('verifyGetterSinceVersions', () => {
  const SOURCE = '/// @custom:version 2.0.0\ncontract SampleFacet {}'

  const requirements = (
    getterSinceVersion: string | undefined,
    getter: string | undefined = 'SPOKEPOOL'
  ): Record<string, IDeployRequirementEntry> => ({
    SampleFacet: {
      configData: {
        _spokePool: {
          configFileName: 'across.json',
          keyInConfigFile: '.<NETWORK>.acrossSpokePool',
          ...(getter === undefined ? {} : { getter }),
          ...(getterSinceVersion === undefined ? {} : { getterSinceVersion }),
        },
      },
    },
  })

  const verify = (
    getterSinceVersion: string | undefined,
    getter?: string,
    source: string | null = SOURCE
  ): string[] =>
    verifyGetterSinceVersions(
      requirements(getterSinceVersion, getter),
      [declaration()],
      () => source
    )

  it('accepts an annotation at or below the version the contract declares', () => {
    expect(verify('1.0.1')).toEqual([])
    expect(verify('2.0.0')).toEqual([])
  })

  it('accepts a contract with no annotation at all', () => {
    expect(verify(undefined)).toEqual([])
  })

  it('rejects an annotation ahead of the declared version', () => {
    // The dangerous case: no deployed build can reach it, so every chain reads as too old and
    // the binding is exempted everywhere at once, silently and permanently.
    const [error] = verify('3.0.0')
    expect(error).toContain('SampleFacet._spokePool')
    expect(error).toContain("ahead of the '2.0.0'")
  })

  it('orders the comparison numerically rather than as text', () => {
    expect(verify('2.0.0')).toEqual([])
    expect(
      verifyGetterSinceVersions(
        requirements('1.10.0'),
        [declaration()],
        () => '/// @custom:version 1.9.0\ncontract SampleFacet {}'
      )
    ).toHaveLength(1)
  })

  it('rejects an annotation the check could never order', () => {
    // Unparseable leaves the binding checked, so it is not dangerous — but it is inert, and an
    // annotation nobody notices is dead weight in a file that decides what goes unverified.
    expect(verify('1.0')).toHaveLength(1)
    expect(verify('1.0.2-tron')[0]).toContain('major.minor.patch')
    // Written unquoted in JSON it arrives as a number, whatever the type says.
    expect(verify(1.0 as unknown as string)[0]).toContain('quoted')
  })

  it('rejects a version annotated on an entry with no getter to read', () => {
    const errors = verifyGetterSinceVersions(
      {
        SampleFacet: {
          configData: {
            _spokePool: {
              configFileName: 'across.json',
              keyInConfigFile: '.<NETWORK>.acrossSpokePool',
              getterSinceVersion: '1.0.1',
            },
          },
        },
      },
      [declaration()],
      () => SOURCE
    )
    expect(errors[0]).toContain('no getter')
  })

  it('reports a contract whose source declares no version to check against', () => {
    expect(
      verify('1.0.1', 'SPOKEPOOL', 'contract SampleFacet {}')[0]
    ).toContain('no @custom:version')
    expect(verify('1.0.1', 'SPOKEPOOL', null)).toHaveLength(1)
  })

  it('passes on the annotations the repo actually carries today', () => {
    // GenericSwapFacetV3 is the only one so far: NATIVE_ADDRESS arrived in 1.0.1, and the
    // contract is at 2.0.0. This is the assertion that fails if someone annotates a version
    // that does not exist.
    const declarations = Object.keys(deployRequirements).map((contract) =>
      declaration({
        contract,
        file: `src/Facets/${contract}.sol`,
      })
    )
    expect(
      verifyGetterSinceVersions(
        deployRequirements as Record<string, IDeployRequirementEntry>,
        declarations,
        (file) => {
          try {
            return readFileSync(file, 'utf8')
          } catch {
            return null
          }
        }
      )
    ).toEqual([])
  })
})
