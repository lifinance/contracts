/**
 * Offsets and lengths use the shape Foundry emits in
 * `deployedBytecode.immutableReferences`: `{ [astId]: [{ start, length }] }`,
 * byte offsets into the runtime code. Measured against
 * `out/AcrossFacet.sol/AcrossFacet.json`, which carries 2 astIds over 4 copies.
 *
 * A repo-wide pass over the artifacts carrying references shows their offsets are
 * real and in range, and nothing more: the slots hold all-zero placeholders until
 * construction, so masking one is a no-op and a hash over it is unchanged. The
 * fixture below holds non-zero bytes at the referenced offsets, which is the only
 * way to observe masking at all.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'
import { keccak256 } from 'viem'

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
    // The three occurrences are contiguous over bytes 32-127, i.e. to the end of
    // this fixture, so the head is the only region left to prove untouched.
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
    const agreeing = CODE
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
    // Picking one silently would report a value the contract does not uniformly
    // hold.
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

describe('against the shapes real artifacts and callers produce', () => {
  it('treats an absent reference set as a contract with no immutables', () => {
    // Foundry omits `immutableReferences` rather than emitting `{}`, and most
    // artifacts in the repo have no immutables at all, so this is the common
    // case reaching the module — not an edge one.
    const masked = maskImmutables(CODE, undefined)
    const read = readImmutableCopies(CODE, undefined)

    expect(masked.ok).toBe(true)
    if (masked.ok) expect(masked.code).toBe(CODE)
    expect(read.ok).toBe(true)
    if (read.ok) expect(read.values).toEqual({})
  })

  it.each([
    ['non-hex code', `0x${'zz'.repeat(64)}`, /not hex/],
    ['half a byte', `0x${'ab'.repeat(63)}c`, /whole bytes/],
    ['no code at all', '0x', /empty/],
  ])('refuses %s rather than masking it', (_label, code, reason) => {
    const masked = maskImmutables(code, REFS)
    const read = readImmutableCopies(code, REFS)

    expect([masked.ok, read.ok]).toEqual([false, false])
    if (!masked.ok) expect(masked.reason).toMatch(reason)
    if (!read.ok) expect(read.reason).toMatch(reason)
  })

  it('refuses an immutable that lists no occurrences', () => {
    // It would otherwise be dropped from the read result rather than compared,
    // and an expectation with nothing to compare against passes by default.
    const result = readImmutableCopies(CODE, { ...REFS, '9001': [] })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/no occurrences/)
  })

  it('says an occurrence is duplicated rather than naming one astId twice', () => {
    const result = maskImmutables(CODE, {
      '8938': [
        { start: 32, length: 32 },
        { start: 32, length: 32 },
      ],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/more than once/)
  })
})

describe('the property layer 1 depends on', () => {
  it('changes the hash it is asked to normalise', () => {
    // Without this, a `maskImmutables` that returned its input unchanged would
    // satisfy every other test in this file, and two deployments differing only
    // in their immutables would compare as different code.
    const masked = maskImmutables(CODE, REFS)

    expect(masked.ok).toBe(true)
    if (!masked.ok) return
    expect(keccak256(masked.code as `0x${string}`)).not.toBe(
      keccak256(CODE as `0x${string}`)
    )
  })

  it('gives two deployments differing only in immutables the same hash', () => {
    const write = (value: string): string => {
      let hex = CODE.slice(2)
      for (const { start, length } of REFS['8938'])
        hex =
          hex.slice(0, start * 2) +
          value.repeat(length) +
          hex.slice((start + length) * 2)
      return `0x${hex}`
    }
    const first = maskImmutables(write('ab'), REFS)
    const second = maskImmutables(write('cd'), REFS)

    expect([first.ok, second.ok]).toEqual([true, true])
    if (!first.ok || !second.ok) return
    // The inputs really did differ, so the equality below is not two identical
    // strings agreeing with each other.
    expect(write('ab')).not.toBe(write('cd'))
    expect(keccak256(first.code as `0x${string}`)).toBe(
      keccak256(second.code as `0x${string}`)
    )
  })
})
