/**
 * Tests for the getter-coverage gate.
 *
 * Pure: the caller supplies the declarations the AST enumeration would produce, so every branch
 * is decidable without Foundry on the runner.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import deployRequirements from '../resources/deployRequirements.json'

import {
  collectAnnotatedGetterKeys,
  collectPublicImmutableGetters,
  readGetterExemptions,
  verifyGetterCoverage,
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
