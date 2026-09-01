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
    // Read the toolchain from the trailer, not from the deployment record,
    // which can disagree with what was deployed.
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
    // 0x60 is PUSH1, not a CBOR map. Solc opens its map 0xa1-0xaf.
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
    // One entry: text(4) 'ipfs' then bytes(34), so 42 bytes of map.
    const noSolc = `0x${'60'.repeat(8)}a164697066735822${'aa'.repeat(34)}002a`
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

/**
 * One source, two lineages. Both are the tail of `AccessManagerFacet`'s
 * `deployedBytecode.object`: 96 code bytes, then a 51-byte trailer, then its
 * length word.
 *
 * - CANCUN_TAIL: `out/` at 67922f138, default profile, solc 0.8.29 / cancun.
 * - LONDON_TAIL: at 67922f138, `FOUNDRY_PROFILE=solc_floor forge build --out
 *   out-floor --contracts src/Facets/AccessManagerFacet.sol` — solc 0.8.17 /
 *   london, the floor every `src/` file pins, built in CI by
 *   `solc-floor-build.yml`. The profile does not redirect `out` itself.
 *
 * The code differs because 0.8.29 emits PUSH0 (`5f`) where 0.8.17 has to spell
 * out `6000`; a lineage difference is not a cosmetic one.
 */
const CANCUN_TAIL =
  '0x5b9150610508602084016104bd565b90509250929050565b5f5f5f60608486031215610523575f5ffd5b61052c84610489565b925061053a602085016104bd565b91506040840135801515811461054e575f5ffd5b80915050925092509256fea2646970667358221220d03ac5dc4a08882370fe06263f9bcf6dee1812146c63a9d19ed384af9919e81e64736f6c634300081d0033'

const LONDON_TAIL =
  '0x0515602084016104c7565b90509250929050565b60008060006060848603121561053357600080fd5b61053c84610492565b925061054a602085016104c7565b91506040840135801515811461055f57600080fd5b80915050925092509256fea26469706673582212205bfef31b47d1e8650e0c547fe943a009dbb2467002129adbfe64624c618a0bf164736f6c63430008110033'

describe('across build lineages', () => {
  it('reads the compiler from the london lineage too, not just the default one', () => {
    const london = readMetadataTrailer(LONDON_TAIL)

    expect(london.present).toBe(true)
    if (!london.present) return
    // 0x11 = 17, against 0x1d = 29 in the cancun fixture: a reader that
    // mis-slices the version triple cannot satisfy both.
    expect(london.solcVersion).toBe('0.8.17')
    expect(london.byteLength).toBe(51)
  })

  it('distinguishes lineages by the decoded version, not by trailer size', () => {
    const cancun = readMetadataTrailer(CANCUN_TAIL)
    const london = readMetadataTrailer(LONDON_TAIL)

    expect([cancun.present, london.present]).toEqual([true, true])
    if (!cancun.present || !london.present) return
    expect(cancun.solcVersion).toBe('0.8.29')
    expect(london.solcVersion).toBe('0.8.17')
    // Both are 51-byte `a2` maps of ipfs + solc, so size carries no lineage
    // information at all.
    expect(london.totalStrippedBytes).toBe(cancun.totalStrippedBytes)
  })

  it('strips both lineages but does not reconcile them', () => {
    const cancun = stripMetadataTrailer(CANCUN_TAIL)
    const london = stripMetadataTrailer(LONDON_TAIL)

    // Both really stripped — without this the inequality below would also hold
    // for two inputs the stripper never touched.
    expect([cancun.stripped, london.stripped]).toEqual([true, true])
    expect(cancun.code.length).toBe(CANCUN_TAIL.length - 53 * 2)
    expect(london.code.length).toBe(LONDON_TAIL.length - 53 * 2)

    // Stripping normalises a rebuild of ONE lineage and leaves two lineages of
    // one source as far apart as before. Whole artifacts: 1370 bytes hashing to 0x9b3646… on cancun
    // against 1387 and 0x632dab… on london. A sign-time gate therefore has to
    // compare against a SET of expected hashes, one per lineage a network can
    // legitimately have been built from — never a single expected value.
    expect(cancun.code).not.toBe(london.code)
  })
})

describe('readMetadataTrailer, against a trailer chosen by the deployer', () => {
  /** Assembles `code || cbor || lengthWord` from a CBOR blob's hex. */
  const withTrailer = (cbor: string): string => {
    const declared = (cbor.length / 2).toString(16).padStart(4, '0')
    return `0x${'60'.repeat(8)}${cbor}${declared}`
  }

  it('refuses a blob carrying the solc key at an offset no map reaches', () => {
    // Searching for the key's characters rather than decoding the map read solc
    // "237.234.219" out of two bytes' nibbles here, and reported it to a signer
    // as fact. Decoding refuses: the map's first key is not a text string.
    const trailer = readMetadataTrailer(
      withTrailer('a1164736f6c6343edeadbeef00')
    )

    expect(trailer.present).toBe(false)
    if (!trailer.present)
      expect(trailer.reason).toMatch(/key is not a text string/)
  })

  it('refuses a map that repeats the solc key', () => {
    // A planted key ahead of the genuine one won on first-match. Two entries
    // under one key leave no way to say which the map means, so neither is read.
    const trailer = readMetadataTrailer(
      withTrailer('a264736f6c634300080a64736f6c634300081d')
    )

    expect(trailer.present).toBe(false)
    if (!trailer.present)
      expect(trailer.reason).toMatch(/repeats the key 'solc'/)
  })

  it.each([
    ['a major version solc has never released', 'a164736f6c6343ff0102'],
    ['a minor beyond any release', 'a164736f6c634300ff02'],
    ['a patch beyond any release', 'a164736f6c63430008ff'],
  ])('reports no version for %s', (_label, cbor) => {
    const trailer = readMetadataTrailer(withTrailer(cbor))

    expect(trailer.present).toBe(true)
    if (trailer.present) expect(trailer.solcVersion).toBeUndefined()
  })

  it('still reads a genuine key at an even offset', () => {
    // The positive control: without it, every assertion above is satisfied by a
    // reader that has simply stopped reading versions.
    const trailer = readMetadataTrailer(withTrailer('a164736f6c634300081d'))

    expect(trailer.present).toBe(true)
    if (trailer.present) expect(trailer.solcVersion).toBe('0.8.29')
  })

  it.each([
    ['b0', /CBOR map/],
    ['b8', /CBOR map/],
    ['bf', /CBOR map/],
  ])(
    'refuses a blob opening 0x%s, which solc does not emit',
    (header, reason) => {
      const trailer = readMetadataTrailer(
        withTrailer(`${header}${'aa'.repeat(9)}`)
      )

      expect(trailer.present).toBe(false)
      if (!trailer.present) expect(trailer.reason).toMatch(reason)
    }
  )

  it('refuses a length word that would leave no code behind', () => {
    // Stripping this returns `0x`, which hashes to a value that is nobody's
    // contract — and would be compared as though it were the deployed code.
    const cbor = `a1${'aa'.repeat(9)}`
    const trailer = readMetadataTrailer(`0x${cbor}000a`)

    expect(trailer.present).toBe(false)
    if (!trailer.present) expect(trailer.reason).toMatch(/leave no code/)
  })

  it('accepts an uppercase 0X prefix', () => {
    expect(readMetadataTrailer(`0X${REAL_TAIL.slice(2)}`).present).toBe(true)
  })
})
