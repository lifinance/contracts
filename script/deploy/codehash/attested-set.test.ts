/**
 * Fixtures are measured on this repo's own artifacts: `AccessManagerFacet` built
 * at the default profile (solc 0.8.29 / cancun, 1423 bytes) and at `solc_floor`
 * (solc 0.8.17 / london, 1440 bytes), each stripped of its metadata trailer and
 * hashed. Provenance and the raw bytes are in `bytecode-trailer.test.ts`.
 */

import {
  describe,
  expect,
  it,
  // eslint-disable-next-line import/no-unresolved
} from 'bun:test'

import { compareToAttestedSet } from './attested-set'
import type { IAttestedBuild } from './attested-set'

const CANCUN_HASH =
  // pre-commit-checker: not a secret — keccak of public runtime bytecode
  '0x9b36461a723520f9ae8b561962cd5622e15a7268f7d978eab84dfb848466a2d9'
const CANCUN_BYTES = 1423
const LONDON_HASH =
  // pre-commit-checker: not a secret — keccak of public runtime bytecode
  '0x632dab2dd5d993b30427c6e779ba627ff5a9db3621b26901502a773aa0938f86'
const LONDON_BYTES = 1440
/** Neither lineage produces this; it stands in for code that is not ours. */
const FOREIGN_HASH = `0x${'ab'.repeat(32)}`

const ATTESTED: IAttestedBuild[] = [
  {
    lineage: 'upstream cancun',
    solcVersion: '0.8.29',
    maskedHash: CANCUN_HASH,
    rawByteLength: CANCUN_BYTES,
  },
  {
    lineage: 'upstream london',
    solcVersion: '0.8.17',
    maskedHash: LONDON_HASH,
    rawByteLength: LONDON_BYTES,
  },
]

/** The network's legitimate toolchains are fully enumerated in ATTESTED. */
const CLOSED = { isClosedSet: true }
/** They are not — e.g. a zkEVM network, whose trailer this repo cannot yet read. */
const OPEN = { isClosedSet: false }

describe('compareToAttestedSet', () => {
  it('accepts a build from any attested lineage, not one privileged profile', () => {
    // E1: a record claiming 0.8.29 must not turn an honest london build red.
    for (const [hash, version, bytes, lineage] of [
      [CANCUN_HASH, '0.8.29', CANCUN_BYTES, 'upstream cancun'],
      [LONDON_HASH, '0.8.17', LONDON_BYTES, 'upstream london'],
    ] as const)
      for (const scope of [CLOSED, OPEN]) {
        const result = compareToAttestedSet(
          { maskedHash: hash, solcVersion: version, rawByteLength: bytes },
          ATTESTED,
          scope
        )

        expect(result.verdict).toBe('MATCH')
        expect(result.matchedLineages).toEqual([lineage])
        expect(result.blocksSigning).toBe(false)
      }
  })

  it('does not depend on the order the attested builds are listed in', () => {
    // Kills any implementation that compares against `builds[0]`.
    const reversed = [...ATTESTED].reverse()

    for (const [hash, version, bytes] of [
      [LONDON_HASH, '0.8.17', LONDON_BYTES],
      [CANCUN_HASH, '0.8.29', CANCUN_BYTES],
    ] as const)
      expect(
        compareToAttestedSet(
          { maskedHash: hash, solcVersion: version, rawByteLength: bytes },
          reversed,
          CLOSED
        ).verdict
      ).toBe('MATCH')
  })

  it('matches a hash reached by two lineages without preferring either', () => {
    // Two compilers can emit identical code once the trailer is off; the masked
    // hash carries no version, so both lineages are named.
    const twins: IAttestedBuild[] = [
      {
        lineage: 'upstream cancun',
        solcVersion: '0.8.29',
        maskedHash: CANCUN_HASH,
        rawByteLength: CANCUN_BYTES,
      },
      {
        lineage: 'tron fork',
        solcVersion: '0.8.29',
        maskedHash: CANCUN_HASH,
        rawByteLength: CANCUN_BYTES,
      },
    ]
    const result = compareToAttestedSet(
      {
        maskedHash: CANCUN_HASH,
        solcVersion: '0.8.29',
        rawByteLength: CANCUN_BYTES,
      },
      twins,
      CLOSED
    )

    expect(result.verdict).toBe('MATCH')
    expect(result.matchedLineages).toEqual(['upstream cancun', 'tron fork'])
  })

  it('ignores case and 0x-prefix differences between hashes', () => {
    const result = compareToAttestedSet(
      {
        maskedHash: CANCUN_HASH.slice(2).toUpperCase(),
        solcVersion: '0.8.29',
        rawByteLength: CANCUN_BYTES,
      },
      ATTESTED,
      CLOSED
    )

    expect(result.verdict).toBe('MATCH')
  })

  it('is UNVERIFIABLE with an empty attested set, under either scope', () => {
    for (const scope of [CLOSED, OPEN]) {
      const result = compareToAttestedSet(
        {
          maskedHash: CANCUN_HASH,
          solcVersion: '0.8.29',
          rawByteLength: CANCUN_BYTES,
        },
        [],
        scope
      )

      expect(result.verdict).toBe('UNVERIFIABLE')
      expect(result.blocksSigning).toBe(true)
      // The verdict alone does not distinguish this from an unbuilt lineage, so
      // assert the message: without its own branch a signer is told the code
      // came from a compiler "no attested build used ()" — an empty list.
      expect(result.reason).toContain('no attested build of main is available')
    }
  })
})

describe('when the normalised hash matches but the deployed length does not', () => {
  // The trailer's length word decides how many bytes come off before hashing,
  // and it is part of the deployed code. Appending a payload plus a length word
  // covering it leaves the stripped prefix — and so the masked hash — untouched.
  it.each([
    ['a payload appended', LONDON_BYTES + 3002],
    ['four bytes appended', LONDON_BYTES + 4],
    ['bytes missing', LONDON_BYTES - 8],
  ])('refuses code with %s', (_label, rawByteLength) => {
    for (const scope of [CLOSED, OPEN]) {
      const result = compareToAttestedSet(
        { maskedHash: LONDON_HASH, solcVersion: '0.8.17', rawByteLength },
        ATTESTED,
        scope
      )

      expect(result.verdict).toBe('MISMATCH')
      expect(result.blocksSigning).toBe(true)
      expect(result.reason).toContain('not accounted for')
    }
  })

  it('says how many bytes are unaccounted for, not merely that it differs', () => {
    const result = compareToAttestedSet(
      {
        maskedHash: LONDON_HASH,
        solcVersion: '0.8.17',
        rawByteLength: LONDON_BYTES + 3002,
      },
      ATTESTED,
      CLOSED
    )

    expect(result.reason).toContain('3002 bytes')
    expect(result.reason).toContain('upstream london')
  })

  it('still matches the attested build whose length agrees', () => {
    // Two builds of one source can share a stripped hash and differ in trailer
    // length — a metadata setting, not a tamper. The one that agrees is a MATCH,
    // and only that one is named.
    const both: IAttestedBuild[] = [
      ...ATTESTED,
      {
        lineage: 'london, metadata hash off',
        solcVersion: '0.8.17',
        maskedHash: LONDON_HASH,
        rawByteLength: LONDON_BYTES - 44,
      },
    ]
    const result = compareToAttestedSet(
      {
        maskedHash: LONDON_HASH,
        solcVersion: '0.8.17',
        rawByteLength: LONDON_BYTES - 44,
      },
      both,
      CLOSED
    )

    expect(result.verdict).toBe('MATCH')
    expect(result.matchedLineages).toEqual(['london, metadata hash off'])
  })
})

describe('with a closed set of legitimate builds', () => {
  it.each([
    ['a version we did build', '0.8.29'],
    // The downgrade attempt: three bytes inside the metadata trailer, no
    // executable code touched. The trailer is part of the deployed code, so the
    // proposer writes it — it must not be able to soften the verdict.
    ['a version we never built', '0.8.99'],
    ['a nonsensical version', '237.234.219'],
  ])(
    'calls foreign code a MISMATCH though it reports %s',
    (_label, version) => {
      const result = compareToAttestedSet(
        {
          maskedHash: FOREIGN_HASH,
          solcVersion: version,
          rawByteLength: CANCUN_BYTES,
        },
        ATTESTED,
        CLOSED
      )

      expect(result.verdict).toBe('MISMATCH')
      expect(result.blocksSigning).toBe(true)
      expect(result.reason).toContain('not a build of main')
    }
  )

  it('calls foreign code a MISMATCH when it reports no version at all', () => {
    // Stripping the trailer, or compiling with `bytecodeHash: "none"`, is the
    // cheapest way to report nothing. It must not buy a softer verdict either.
    const result = compareToAttestedSet(
      { maskedHash: FOREIGN_HASH, rawByteLength: CANCUN_BYTES },
      ATTESTED,
      CLOSED
    )

    expect(result.verdict).toBe('MISMATCH')
  })

  it('reaches the same verdict for every trailer a tamperer could write', () => {
    // One fact — this hash is in none of the attested builds — must produce one
    // verdict, no matter what the code says about itself.
    const verdicts = new Set(
      [
        {
          maskedHash: FOREIGN_HASH,
          solcVersion: '0.8.29',
          rawByteLength: 1423,
        },
        {
          maskedHash: FOREIGN_HASH,
          solcVersion: '0.8.17',
          rawByteLength: 1423,
        },
        {
          maskedHash: FOREIGN_HASH,
          solcVersion: '0.8.99',
          rawByteLength: 9999,
        },
        { maskedHash: FOREIGN_HASH, rawByteLength: 12 },
      ].map(
        (observed) => compareToAttestedSet(observed, ATTESTED, CLOSED).verdict
      )
    )

    expect([...verdicts]).toEqual(['MISMATCH'])
  })
})

describe('with an open set of legitimate builds', () => {
  it('calls a foreign hash from an attested lineage a MISMATCH', () => {
    const result = compareToAttestedSet(
      {
        maskedHash: FOREIGN_HASH,
        solcVersion: '0.8.29',
        rawByteLength: CANCUN_BYTES,
      },
      ATTESTED,
      OPEN
    )

    expect(result.verdict).toBe('MISMATCH')
    expect(result.reason).toContain('0.8.29')
  })

  it('calls a foreign hash from an unbuilt lineage UNVERIFIABLE', () => {
    // With the set open we may simply never have built this toolchain, so a
    // non-match is ignorance rather than evidence. This is the branch the
    // closed-set tests above prove cannot be reached by a tamperer.
    const result = compareToAttestedSet(
      {
        maskedHash: FOREIGN_HASH,
        solcVersion: '0.8.31',
        rawByteLength: CANCUN_BYTES,
      },
      ATTESTED,
      OPEN
    )

    expect(result.verdict).toBe('UNVERIFIABLE')
    expect(result.blocksSigning).toBe(true)
    expect(result.reason).toContain('0.8.31')
  })

  it('is UNVERIFIABLE when the deployed code carries no compiler version', () => {
    const result = compareToAttestedSet(
      { maskedHash: FOREIGN_HASH, rawByteLength: CANCUN_BYTES },
      ATTESTED,
      OPEN
    )

    expect(result.verdict).toBe('UNVERIFIABLE')
    expect(result.reason).toMatch(/no readable compiler version/i)
  })

  it('keeps GREY distinct from RED while blocking on both', () => {
    const grey = compareToAttestedSet(
      {
        maskedHash: FOREIGN_HASH,
        solcVersion: '0.8.31',
        rawByteLength: CANCUN_BYTES,
      },
      ATTESTED,
      OPEN
    )
    const red = compareToAttestedSet(
      {
        maskedHash: FOREIGN_HASH,
        solcVersion: '0.8.29',
        rawByteLength: CANCUN_BYTES,
      },
      ATTESTED,
      OPEN
    )

    // Fail closed: both block. Visibly distinct: the verdicts differ, and the
    // renderer downstream keys off the verdict, never off `blocksSigning`.
    expect([grey.blocksSigning, red.blocksSigning]).toEqual([true, true])
    expect(grey.verdict).not.toBe(red.verdict)
  })
})
