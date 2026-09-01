/**
 * Fixtures are the two lineage hashes measured on this repo's own artifacts:
 * `AccessManagerFacet` built at the default profile (solc 0.8.29 / cancun) and
 * at `solc_floor` (solc 0.8.17 / london), each stripped of its metadata trailer
 * and hashed. Provenance and the raw bytes are in `bytecode-trailer.test.ts`.
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
const LONDON_HASH =
  // pre-commit-checker: not a secret — keccak of public runtime bytecode
  '0x632dab2dd5d993b30427c6e779ba627ff5a9db3621b26901502a773aa0938f86'
/** Neither lineage produces this; it stands in for code that is not ours. */
const FOREIGN_HASH = `0x${'ab'.repeat(32)}`

const ATTESTED: IAttestedBuild[] = [
  {
    lineage: 'upstream cancun',
    solcVersion: '0.8.29',
    maskedHash: CANCUN_HASH,
  },
  {
    lineage: 'upstream london',
    solcVersion: '0.8.17',
    maskedHash: LONDON_HASH,
  },
]

describe('compareToAttestedSet', () => {
  it('accepts a build from any attested lineage, not one privileged profile', () => {
    // E1: a record claiming 0.8.29 must not turn an honest london build red.
    // Both lineages are legitimate builds of main, so both are GREEN.
    for (const [hash, version, lineage] of [
      [CANCUN_HASH, '0.8.29', 'upstream cancun'],
      [LONDON_HASH, '0.8.17', 'upstream london'],
    ] as const) {
      const result = compareToAttestedSet(
        { maskedHash: hash, solcVersion: version },
        ATTESTED
      )

      expect(result.verdict).toBe('MATCH')
      expect(result.matchedLineages).toEqual([lineage])
      expect(result.blocksSigning).toBe(false)
    }
  })

  it('does not depend on the order the attested builds are listed in', () => {
    // Kills any implementation that compares against `builds[0]`.
    const reversed = [...ATTESTED].reverse()

    expect(
      compareToAttestedSet(
        { maskedHash: LONDON_HASH, solcVersion: '0.8.17' },
        reversed
      ).verdict
    ).toBe('MATCH')
    expect(
      compareToAttestedSet(
        { maskedHash: CANCUN_HASH, solcVersion: '0.8.29' },
        reversed
      ).verdict
    ).toBe('MATCH')
  })

  it('calls a foreign hash from an attested lineage a MISMATCH', () => {
    // We built this exact lineage, so a disagreement is a real finding.
    const result = compareToAttestedSet(
      { maskedHash: FOREIGN_HASH, solcVersion: '0.8.29' },
      ATTESTED
    )

    expect(result.verdict).toBe('MISMATCH')
    expect(result.blocksSigning).toBe(true)
    expect(result.reason).toContain('0.8.29')
  })

  it('calls a foreign hash from an UNBUILT lineage UNVERIFIABLE, not a MISMATCH', () => {
    // Nothing was ever built at 0.8.31, so a non-match is ignorance, not
    // evidence. Reporting it as RED would train signers to wave through red.
    const result = compareToAttestedSet(
      { maskedHash: FOREIGN_HASH, solcVersion: '0.8.31' },
      ATTESTED
    )

    expect(result.verdict).toBe('UNVERIFIABLE')
    expect(result.blocksSigning).toBe(true)
    expect(result.reason).toContain('0.8.31')
  })

  it('is UNVERIFIABLE when the deployed code carries no compiler version', () => {
    // No trailer means the lineage cannot be established, so neither a match
    // nor a mismatch can be claimed.
    const result = compareToAttestedSet({ maskedHash: FOREIGN_HASH }, ATTESTED)

    expect(result.verdict).toBe('UNVERIFIABLE')
    expect(result.blocksSigning).toBe(true)
    expect(result.reason).toMatch(/no readable compiler version/i)
  })

  it('is UNVERIFIABLE with an empty attested set rather than vacuously RED', () => {
    const result = compareToAttestedSet(
      { maskedHash: CANCUN_HASH, solcVersion: '0.8.29' },
      []
    )

    expect(result.verdict).toBe('UNVERIFIABLE')
    expect(result.blocksSigning).toBe(true)
    // The verdict alone does not distinguish this from an unbuilt lineage, so
    // assert the message: without its own branch the signer is told the code
    // came from a compiler "no attested build used ()" — an empty list.
    expect(result.reason).toContain('no attested build of main is available')
  })

  it('keeps GREY distinct from RED while blocking on both', () => {
    const grey = compareToAttestedSet({ maskedHash: FOREIGN_HASH }, ATTESTED)
    const red = compareToAttestedSet(
      { maskedHash: FOREIGN_HASH, solcVersion: '0.8.29' },
      ATTESTED
    )

    // Fail closed: both block. Visibly distinct: the verdicts differ, and the
    // renderer downstream keys off the verdict, never off `blocksSigning`.
    expect([grey.blocksSigning, red.blocksSigning]).toEqual([true, true])
    expect(grey.verdict).not.toBe(red.verdict)
  })

  it('matches a hash reached by two lineages without preferring either', () => {
    // Two compilers can emit identical code once the trailer is off; the
    // masked hash carries no version, so both lineages are named.
    const twins: IAttestedBuild[] = [
      {
        lineage: 'upstream cancun',
        solcVersion: '0.8.29',
        maskedHash: CANCUN_HASH,
      },
      { lineage: 'tron fork', solcVersion: '0.8.29', maskedHash: CANCUN_HASH },
    ]
    const result = compareToAttestedSet(
      { maskedHash: CANCUN_HASH, solcVersion: '0.8.29' },
      twins
    )

    expect(result.verdict).toBe('MATCH')
    expect(result.matchedLineages).toEqual(['upstream cancun', 'tron fork'])
  })

  it('ignores case and 0x-prefix differences between hashes', () => {
    const result = compareToAttestedSet(
      { maskedHash: CANCUN_HASH.slice(2).toUpperCase(), solcVersion: '0.8.29' },
      ATTESTED
    )

    expect(result.verdict).toBe('MATCH')
  })
})
