/**
 * Fixtures are assembled by hand from the CBOR encoding, and the positive one is
 * the real trailer of `out/AccessManagerFacet.sol/AccessManagerFacet.json`.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { decodeCborMap } from './cbor-map'

/** The real thing: `{ ipfs: h'…', solc: h'00081d' }`, 51 bytes. */
const REAL_TRAILER =
  'a2646970667358221220d03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e64736f6c634300081d'

describe('decodeCborMap', () => {
  it('decodes a real solc trailer into its entries', () => {
    const result = decodeCborMap(REAL_TRAILER)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(Object.keys(result.entries).sort()).toEqual(['ipfs', 'solc'])
    expect(result.entries['solc']).toBe('00081d')
    expect(result.entries['ipfs']).toHaveLength(68)
  })

  it('decodes the boolean value solc writes for experimental builds', () => {
    // `{ solc: h'00081d', experimental: true }`
    const result = decodeCborMap(
      'a264736f6c634300081d6c6578706572696d656e74616cf5'
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entries['experimental']).toBe('true')
  })

  it('refuses a map header that promises more entries than the bytes hold', () => {
    // The case a first-byte range check cannot see: `a1` with nothing after it
    // decodes as "a map" under a range check, and 3 of 4 bytes get stripped off
    // a contract that has no trailer at all.
    const result = decodeCborMap('a1')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/ends before its keys do/)
  })

  it('refuses bytes left over after the map decodes', () => {
    // A trailing byte means the declared length and the structure disagree, so
    // the number of bytes to strip would be a guess.
    const result = decodeCborMap(`${REAL_TRAILER}ff`)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/decodes in 51 of 52 bytes/)
  })

  it.each([
    ['an empty blob', '', /empty/],
    ['a text string', '6449504653', /not a CBOR map header/],
    ['an array', '82616101', /not a CBOR map header/],
    [
      'an indefinite-length map',
      'bf64736f6c634300081dff',
      /not a CBOR map header/,
    ],
    ['a non-text key', 'a1164736f6c6343000000', /key is not a text string/],
    ['a nested map as a value', 'a164736f6c63a0', /not a value solc emits/],
    ['a key running past the end', 'a16f736f6c63', /runs past the blob/],
    [
      'a value running past the end',
      'a164736f6c635822aa',
      /runs past the blob/,
    ],
  ])('refuses %s', (_label, hex, reason) => {
    const result = decodeCborMap(hex)

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(reason)
  })

  it('refuses a repeated key rather than picking an entry', () => {
    const result = decodeCborMap('a264736f6c634300080a64736f6c634300081d')

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/repeats the key 'solc'/)
  })

  it('decodes an empty map, which is well-formed but carries nothing', () => {
    const result = decodeCborMap('a0')

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entries).toEqual({})
  })
})
