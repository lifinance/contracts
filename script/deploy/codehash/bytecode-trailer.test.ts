/**
 * Fixtures are real bytes, not synthetic ones, and they are EMBEDDED rather than
 * read from `out/` — CI has no build artifacts, so a test that reads them either
 * fails there or passes vacuously.
 *
 * Provenance: the tail of `out/AccessManagerFacet.sol/AccessManagerFacet.json`
 * `deployedBytecode.object` at `ce1b2760c`, solc 0.8.29, 1423 bytes total,
 * 51-byte CBOR trailer.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { readMetadataTrailer, stripMetadataTrailer } from './bytecode-trailer'

/** Real tail: 7 bytes of code, then a 51-byte CBOR trailer, then its length. */
const REAL_TAIL =
  '0x925092509256fea2646970667358221220d03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e64736f6c634300081d0033'

/** The same, with the trailing length word claiming more than exists. */
const OVERLONG_LENGTH = `${REAL_TAIL.slice(0, -4)}ffff`

describe('readMetadataTrailer', () => {
  it('reads the length, the CBOR blob and the compiler from a real trailer', () => {
    const trailer = readMetadataTrailer(REAL_TAIL)

    expect(trailer.present).toBe(true)
    if (!trailer.present) return
    expect(trailer.byteLength).toBe(51)
    // The whole trailer plus its own 2-byte length word.
    expect(trailer.totalStrippedBytes).toBe(53)
    // Constraint from the fleet sweep: read the toolchain from the trailer, not
    // from the deployment record, which can disagree with what was deployed.
    expect(trailer.solcVersion).toBe('0.8.29')
  })

  it('reports absence rather than guessing when there is no trailer', () => {
    // A length word of 0 is not a zero-length trailer; it means the bytes are
    // not a solc metadata trailer at all.
    expect(readMetadataTrailer('0x60806040520000').present).toBe(false)
  })

  it('refuses a length word claiming more bytes than exist', () => {
    // Stripping on this would cut into real code and silently change the hash
    // the whole gate compares.
    const trailer = readMetadataTrailer(OVERLONG_LENGTH)

    expect(trailer.present).toBe(false)
    if (!trailer.present) expect(trailer.reason).toMatch(/longer than/)
  })

  it('refuses bytes whose blob does not start with a CBOR map header', () => {
    // 0x60 is PUSH1, not a CBOR map. Solc's trailer always opens 0xa1-0xbf.
    // Without this, any contract whose last two bytes happen to look like a
    // plausible length gets its tail amputated.
    const notCbor = `0x${'60'.repeat(20)}0004`
    const trailer = readMetadataTrailer(notCbor)

    expect(trailer.present).toBe(false)
    if (!trailer.present) expect(trailer.reason).toMatch(/CBOR map/)
  })

  it('reports no compiler rather than a wrong one when the key is absent', () => {
    // A trailer without the solc key is legitimate. Returning undefined lets the
    // caller decide; inventing a version would be compared against as fact.
    const noSolc = '0xa1646970667358221220' + 'aa'.repeat(34) + '000b'
    const trailer = readMetadataTrailer(noSolc)

    expect(trailer.present).toBe(true)
    if (trailer.present) expect(trailer.solcVersion).toBeUndefined()
  })

  // The REASON is asserted, not just the refusal. Several of these inputs are
  // caught by more than one guard, so `present === false` alone passes even with
  // the specific guard removed.
  it.each([
    ['not hex', '0xzz', /not hex/],
    ['odd-length hex', '0xabc', /whole bytes/],
    ['empty', '0x', /empty/],
    ['shorter than a length word', '0xab', /shorter than a length word/],
  ])('refuses %s input, and says why', (_label, input, reason) => {
    const trailer = readMetadataTrailer(input)

    expect(trailer.present).toBe(false)
    if (!trailer.present) expect(trailer.reason).toMatch(reason)
  })
})

describe('stripMetadataTrailer', () => {
  it('removes exactly the trailer and its length word', () => {
    const { code, stripped } = stripMetadataTrailer(REAL_TAIL)

    expect(stripped).toBe(true)
    // 60 bytes in, 53 stripped, 7 left.
    expect(code).toBe('0x92509250925' + '6fe')
    expect((code.length - 2) / 2).toBe(7)
  })

  it('returns the input unchanged when there is no trailer to strip', () => {
    const input = '0x60806040520000'

    const { code, stripped } = stripMetadataTrailer(input)

    expect(stripped).toBe(false)
    expect(code).toBe(input)
  })

  it('leaves the code alone when the length word overclaims', () => {
    // Fail closed: an unstrippable trailer must not become a truncated code.
    const { code, stripped } = stripMetadataTrailer(OVERLONG_LENGTH)

    expect(stripped).toBe(false)
    expect(code).toBe(OVERLONG_LENGTH)
  })

  it('is idempotent — stripping twice removes only one trailer', () => {
    // The remaining code must not look like a trailer to a second pass, or a
    // caller that normalises defensively would eat real bytes.
    const once = stripMetadataTrailer(REAL_TAIL).code

    expect(stripMetadataTrailer(once).code).toBe(once)
  })
})
