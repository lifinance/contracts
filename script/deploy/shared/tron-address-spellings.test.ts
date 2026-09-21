/**
 * Pinned against the five production Tron facets that reproduce from the fork,
 * because this translation is the step that decided whether the codehash gate
 * found their records at all: it read every one of them as an address nobody
 * deployed.
 */
import { describe, expect, it } from 'bun:test' // eslint-disable-line import/no-unresolved

import { createTronAddressSpellings } from './tron-address-spellings'

/**
 * Real production records: base58 as the store holds it, hex as a cut carries
 * it. Corroborated on chain rather than taken from this module's own output —
 * the deployed code read at each hex address reproduces from the commit the
 * base58-keyed record names, which is the mapping itself.
 */
const REAL_PAIRS: readonly [string, string][] = [
  [
    'TNZ3fznhvEssLeovS9Uc7zCLgYjKdNjX9P',
    '0x8a07dd6ca9ea2dccff2a0015811c895ac1abfcc5',
  ],
  [
    'TSZnVJnhPCH8PECjEY4zNbv7kK1XiBUwwb',
    '0xb60c1bdb71918c0105a4b5abeaa08e353674a3f4',
  ],
  [
    'TMck2qdZHmsdurz4uE4eNVBt14JHHLeoEB',
    '0x7fc2ad654bbe72fef9f46d92a9f51dc10d3b8c7e',
  ],
  [
    'TR15epdwXG9kBXtEBnF5bv6kSYRY5w6mXY',
    '0xa4e49588c1e391c202ac1d94ad8b69b6fe1da3e1',
  ],
  [
    'TBFPs7mxPN3nCrnmbjrJh6BS48VpGbu6oQ',
    '0x0e07d966239d00a7fb445d4cb06b478a0e538b3b',
  ],
]

describe('createTronAddressSpellings', () => {
  it('is absent for a network that spells addresses one way', () => {
    expect(createTronAddressSpellings('mainnet')).toBeUndefined()
    expect(createTronAddressSpellings('lens')).toBeUndefined()
  })

  it('offers both spellings for a Tron network', () => {
    const spellings = createTronAddressSpellings('tron')
    expect(spellings).toBeDefined()
    expect(createTronAddressSpellings('tronshasta')).toBeDefined()
  })

  it('maps every real production facet address to the hex a cut carries', () => {
    const spellings = createTronAddressSpellings('tron')
    if (!spellings) throw new Error('tron has no spellings')
    for (const [base58, hex] of REAL_PAIRS) {
      expect(spellings.toCalldataSpelling(base58)).toBe(hex)
      expect(spellings.forCalldataAddress(hex)).toEqual([hex, base58])
    }
  })

  it("does not answer one facet with another facet's spelling", () => {
    const spellings = createTronAddressSpellings('tron')
    if (!spellings) throw new Error('tron has no spellings')
    const hexes = REAL_PAIRS.map(([base58]) =>
      spellings.toCalldataSpelling(base58)
    )
    expect(new Set(hexes).size).toBe(REAL_PAIRS.length)
  })

  it('keeps the calldata spelling first, so a hex-written record is still found', () => {
    const spellings = createTronAddressSpellings('tron')
    if (!spellings) throw new Error('tron has no spellings')
    const hex = spellings.toCalldataSpelling(
      REAL_PAIRS[0]?.[0] as string
    ) as string
    expect(spellings.forCalldataAddress(hex)[0]).toBe(hex)
  })

  it.each([
    ['n/a', 'a config idiom this repo already uses elsewhere'],
    ['true', 'a boolean written as a word'],
    ['null', 'an absent value written as a word'],
    ['TODO', 'a placeholder left in config'],
    ['', 'an empty string'],
    [
      'TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFX',
      'a real address with a broken checksum',
    ],
  ])('refuses %s rather than reading it as the zero address', (value) => {
    const spellings = createTronAddressSpellings('tron')
    if (!spellings) throw new Error('tron has no spellings')
    // The codec answers each of the first four with 0x00…0 instead of
    // refusing. Left unchecked that becomes an expectation, and an immutable
    // legitimately holding zero would satisfy it.
    expect(spellings.toCalldataSpelling(value)).toBeUndefined()
  })

  it('still reads every real address after that guard', () => {
    const spellings = createTronAddressSpellings('tron')
    if (!spellings) throw new Error('tron has no spellings')
    for (const [base58, hex] of REAL_PAIRS)
      expect(spellings.toCalldataSpelling(base58)).toBe(hex)
  })

  it('reads the hex spellings a record may carry as well as base58', () => {
    const spellings = createTronAddressSpellings('tron')
    if (!spellings) throw new Error('tron has no spellings')
    const [base58, hex] = REAL_PAIRS[0] as [string, string]
    const bare = hex.slice(2)
    expect(spellings.toCalldataSpelling(hex)).toBe(hex)
    expect(spellings.toCalldataSpelling(bare)).toBe(hex)
    expect(spellings.toCalldataSpelling(`41${bare}`)).toBe(hex)
    expect(spellings.toCalldataSpelling(base58)).toBe(hex)
  })

  it('falls back to the address itself rather than throwing on nonsense', () => {
    const spellings = createTronAddressSpellings('tron')
    if (!spellings) throw new Error('tron has no spellings')
    expect(spellings.toCalldataSpelling('not-an-address')).toBeUndefined()
    expect(spellings.forCalldataAddress('0xnothex')).toEqual(['0xnothex'])
  })
})
