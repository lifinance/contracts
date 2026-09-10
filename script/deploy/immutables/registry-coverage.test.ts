/**
 * `configData` keys are written as `deployRequirements.json` writes them. They
 * look like constructor parameters but are free-form labels — `AcrossFacet`
 * files `_wrappedNativeAddress` for a parameter called `_wrappedNative` — which
 * is why the matcher below is a suggester and not a gate.
 *
 * Declaration names are the naming conventions the heuristic has to bridge, not
 * a transcript of `src/`; the AcrossFacet case below is the one fixture that
 * carries that contract's real names, and it is deliberately the case where the
 * heuristic only half-succeeds.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import type { IImmutableDeclaration } from './immutable-ast'
import {
  assessRegistryCoverage,
  normaliseBindingName,
} from './registry-coverage'

const declared = (
  name: string,
  contract = 'AcrossFacet',
  file = `src/Facets/${contract}.sol`
): IImmutableDeclaration => ({
  file,
  contract,
  line: 20,
  type: 'address',
  visibility: 'public',
  name,
})

describe('normaliseBindingName', () => {
  it.each([
    ['_spokePool', 'spokepool'],
    ['SPOKE_POOL', 'spokepool'],
    ['spokePool', 'spokepool'],
    ['_wrappedNativeAddress', 'wrappednativeaddress'],
    ['WRAPPED_NATIVE_ADDRESS', 'wrappednativeaddress'],
  ])(
    'maps %p to %p so a parameter and its immutable meet',
    (input, expected) => {
      expect(normaliseBindingName(input)).toBe(expected)
    }
  )

  it('does not collapse two genuinely different names', () => {
    expect(normaliseBindingName('POOL_MANAGER')).not.toBe(
      normaliseBindingName('POOL_MANAGER_V2')
    )
  })
})

describe('assessRegistryCoverage', () => {
  it('matches an immutable to the constructor parameter it is assigned from', () => {
    const result = assessRegistryCoverage(
      [declared('SPOKE_POOL'), declared('WRAPPED_NATIVE_ADDRESS')],
      { AcrossFacet: ['_spokePool', '_wrappedNativeAddress'] }
    )

    expect(result.undeclared).toEqual([])
    expect(result.orphanedEntries).toEqual([])
    expect(result.covered).toHaveLength(2)
  })

  it('half-matches AcrossFacet, the case the registry exists for', () => {
    // The names this contract really declares. `wrappedNative` and the label
    // `_wrappedNativeAddress` differ by a word, so the heuristic cannot link
    // them and reports the immutable and the label separately. A gate reading
    // this as a verdict would call a correctly configured contract broken.
    const result = assessRegistryCoverage(
      [declared('spokePool'), declared('wrappedNative')],
      { AcrossFacet: ['_spokePool', '_wrappedNativeAddress'] }
    )

    expect(result.covered.map((d) => d.name)).toEqual(['spokePool'])
    expect(result.undeclared.map((d) => d.name)).toEqual(['wrappedNative'])
    expect(result.orphanedEntries).toEqual([
      { contract: 'AcrossFacet', entry: '_wrappedNativeAddress' },
    ])
  })

  it('reports an immutable with no registry entry', () => {
    // The authoring gap part (ii) closes. It has to be visible per contract and
    // per name, not as a count.
    const result = assessRegistryCoverage(
      [declared('SPOKE_POOL'), declared('SOMETHING_NEW')],
      { AcrossFacet: ['_spokePool'] }
    )

    expect(result.undeclared.map((d) => d.name)).toEqual(['SOMETHING_NEW'])
    expect(result.undeclared[0]?.file).toBe('src/Facets/AcrossFacet.sol')
  })

  it('reports a registry entry with no immutable, which is the worse direction', () => {
    // An unmatched entry is either a renamed immutable whose expectation
    // silently stopped being checked, or just a differently-spelled label. The
    // suggester cannot tell them apart, which is the whole reason it reports
    // rather than fails.
    const result = assessRegistryCoverage([declared('SPOKE_POOL')], {
      AcrossFacet: ['_spokePool', '_removedThing'],
    })

    expect(result.orphanedEntries).toEqual([
      { contract: 'AcrossFacet', entry: '_removedThing' },
    ])
  })

  it('treats a contract absent from the registry as fully undeclared', () => {
    const result = assessRegistryCoverage(
      [declared('POOL_MANAGER', 'BrandNewFacet')],
      { AcrossFacet: ['_spokePool'] }
    )

    expect(result.undeclared.map((d) => d.name)).toEqual(['POOL_MANAGER'])
    expect(result.orphanedEntries).toEqual([
      { contract: 'AcrossFacet', entry: '_spokePool' },
    ])
  })

  it('keys on the contract name, wherever in the tree the file sits', () => {
    const result = assessRegistryCoverage(
      [
        declared(
          'SPOKE_POOL',
          'AcrossFacet',
          'src/Periphery/Nested/AcrossFacet.sol'
        ),
      ],
      { AcrossFacet: ['_spokePool'] }
    )

    expect(result.undeclared).toEqual([])
  })

  it('does not let a helper contract be covered by entries filed under its file', () => {
    // Both contracts live in AcrossFacet.sol, so a basename key would file the
    // helper's immutable under AcrossFacet and count it as covered.
    const result = assessRegistryCoverage(
      [declared('SPOKE_POOL', 'AcrossHelper', 'src/Facets/AcrossFacet.sol')],
      { AcrossFacet: ['_spokePool'] }
    )

    expect(result.undeclared.map((d) => d.name)).toEqual(['SPOKE_POOL'])
    expect(result.orphanedEntries).toEqual([
      { contract: 'AcrossFacet', entry: '_spokePool' },
    ])
  })

  it('keeps two files of the same basename apart', () => {
    // Both contracts carry an entry of their own, so a basename key would spend
    // AcrossFacet's on the V4 declaration and leave V4's entry orphaned.
    const result = assessRegistryCoverage(
      [
        declared('SPOKE_POOL', 'AcrossFacet', 'src/Facets/AcrossFacet.sol'),
        declared('SPOKE_POOL', 'AcrossFacetV4', 'src/V4/AcrossFacet.sol'),
      ],
      { AcrossFacet: ['_spokePool'], AcrossFacetV4: ['_spokePool'] }
    )

    expect(result.covered.map((d) => d.contract)).toEqual([
      'AcrossFacet',
      'AcrossFacetV4',
    ])
    expect(result.undeclared).toEqual([])
    expect(result.orphanedEntries).toEqual([])
  })

  it('counts nothing as covered when there is nothing declared', () => {
    // A registry with entries and a source tree with no immutables is every
    // entry orphaned, not a clean pass.
    const result = assessRegistryCoverage([], { AcrossFacet: ['_spokePool'] })

    expect(result.covered).toEqual([])
    expect(result.orphanedEntries).toHaveLength(1)
  })

  it('does not let one contract cover another contract of the same shape', () => {
    // Two facets can take a parameter of the same name; an entry only covers the
    // contract it is filed under.
    const result = assessRegistryCoverage(
      [declared('SPOKE_POOL', 'OtherFacet')],
      { AcrossFacet: ['_spokePool'] }
    )

    expect(result.undeclared.map((d) => d.name)).toEqual(['SPOKE_POOL'])
  })
})
