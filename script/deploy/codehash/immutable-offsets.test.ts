/**
 * Offsets and lengths use the shape Foundry emits in
 * `deployedBytecode.immutableReferences`: `{ [astId]: [{ start, length }] }`,
 * byte offsets into the runtime code. Measured against
 * `out/AcrossFacet.sol/AcrossFacet.json`, which carries 2 astIds over 4 copies.
 *
 * A repo-wide pass over all 42 artifacts that carry references is the realism
 * evidence; these cases pin the behaviour a single artifact cannot show, notably
 * the failure paths.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { maskImmutables, readImmutableCopies } from './immutable-offsets'

/** 128 bytes of distinguishable filler. */
const CODE = `0x${Array.from({ length: 128 }, (_, i) =>
  i.toString(16).padStart(2, '0')
).join('')}`

/** Two immutables, the first with two copies — the shape that can disagree. */
const REFS = {
  '8938': [
    { start: 32, length: 32 },
    { start: 64, length: 32 },
  ],
  '8941': [{ start: 96, length: 32 }],
}

describe('maskImmutables', () => {
  it('zeroes every occurrence and leaves the rest untouched', () => {
    const result = maskImmutables(CODE, REFS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Same length: masking must not shift a single byte, or every offset after
    // it means something else.
    expect(result.code.length).toBe(CODE.length)
    const body = result.code.slice(2)
    expect(body.slice(64, 128)).toBe('00'.repeat(32))
    expect(body.slice(128, 192)).toBe('00'.repeat(32))
    expect(body.slice(192, 256)).toBe('00'.repeat(32))
    // Unmasked bytes are original. The last immutable covers bytes 96-127, i.e.
    // the end of this 128-byte fixture, so the only untouched regions are the
    // head and the gap at byte 95 — there is no tail to check.
    expect(body.slice(0, 2)).toBe('00')
    expect(body.slice(2, 4)).toBe('01')
    expect(body.slice(62, 64)).toBe('1f')
  })

  it('is unchanged by masking twice', () => {
    const once = maskImmutables(CODE, REFS)
    expect(once.ok).toBe(true)
    if (!once.ok) return

    const twice = maskImmutables(once.code, REFS)
    expect(twice.ok).toBe(true)
    if (twice.ok) expect(twice.code).toBe(once.code)
  })

  it('returns the code untouched when there are no references', () => {
    const result = maskImmutables(CODE, {})

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.code).toBe(CODE)
  })

  it('refuses an occurrence that runs past the end of the code', () => {
    // Masking on this would either throw or silently mask nothing, and a hash
    // over partly-masked code is compared as though it were normalised.
    const result = maskImmutables(CODE, { '1': [{ start: 120, length: 32 }] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/past the end/)
  })

  it.each([
    ['a negative start', { start: -1, length: 32 }],
    ['a zero length', { start: 32, length: 0 }],
    ['a negative length', { start: 32, length: -32 }],
    ['a fractional start', { start: 32.5, length: 32 }],
  ])('refuses %s', (_label, occurrence) => {
    expect(maskImmutables(CODE, { '1': [occurrence] }).ok).toBe(false)
  })

  it('refuses overlapping occurrences', () => {
    // Overlap means one of the two offsets is wrong, and masking both would
    // hide that rather than surface it.
    const result = maskImmutables(CODE, {
      '1': [{ start: 32, length: 32 }],
      '2': [{ start: 48, length: 32 }],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/overlap/)
  })
})

describe('readImmutableCopies', () => {
  it('reads each value once when every copy agrees', () => {
    const agreeing = maskImmutables(CODE, {}).ok ? CODE : CODE
    // Write the same value at both of astId 8938's offsets.
    const value = 'ab'.repeat(32)
    const body = agreeing.slice(2).split('')
    for (const start of [32, 64]) body.splice(start * 2, 64, ...value.split(''))
    const code = `0x${body.join('')}`

    const result = readImmutableCopies(code, REFS)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.values['8938']).toBe(`0x${value}`)
    expect(Object.keys(result.values)).toHaveLength(2)
  })

  it('refuses when two copies of one immutable disagree', () => {
    // The spike requires every copy to agree. Picking one silently would report
    // a value the contract does not uniformly hold.
    const result = readImmutableCopies(CODE, REFS)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toMatch(/disagree/)
      expect(result.reason).toContain('8938')
    }
  })

  it('refuses an occurrence past the end rather than reading short', () => {
    expect(
      readImmutableCopies(CODE, { '1': [{ start: 120, length: 32 }] }).ok
    ).toBe(false)
  })
})
