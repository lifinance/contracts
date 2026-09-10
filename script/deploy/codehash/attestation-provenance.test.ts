/**
 * What the provenance grading must never let a signer conclude.
 *
 * The failure this module exists to prevent is a local rebuild reading as CI
 * attestation, so most of these tests are about what does *not* count as
 * attested — paired with the one case that does, so a grading that refused
 * everything would fail too.
 */
// eslint-disable-next-line import/no-unresolved
import { describe, expect, it } from 'bun:test'

import { gradeMatchProvenance } from './attestation-provenance'
import { compareToAttestedSet, type IAttestedBuild } from './attested-set'

const HASH_A = `0x${'aa'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic masked hash
const HASH_B = `0x${'bb'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic masked hash

const build = (
  provenance: 'A-CI' | 'A-LOCAL',
  maskedHash: string,
  over: Partial<IAttestedBuild> = {}
): IAttestedBuild => ({
  lineage: provenance === 'A-CI' ? 'CI mint' : 'local rebuild',
  provenance,
  solcVersion: '0.8.29',
  maskedHash,
  rawByteLength: 1440,
  rawHash: undefined,
  ...over,
})

const ci = (maskedHash: string, over?: Partial<IAttestedBuild>) =>
  build('A-CI', maskedHash, over)
const local = (maskedHash: string, over?: Partial<IAttestedBuild>) =>
  build('A-LOCAL', maskedHash, over)

describe('gradeMatchProvenance', () => {
  it('presents a CI-attested match as attested', () => {
    // The paired present: the grading can say yes, so every refusal below
    // means something.
    const verdict = gradeMatchProvenance([ci(HASH_A)], [ci(HASH_A)])

    expect(verdict.grade).toBe('ci-attested')
    expect(verdict.presentableAsAttested).toBe(true)
  })

  it('never presents a local rebuild as attested', () => {
    const verdict = gradeMatchProvenance([local(HASH_A)], [local(HASH_A)])

    expect(verdict.grade).toBe('locally-rebuilt')
    expect(verdict.presentableAsAttested).toBe(false)
  })

  it('does not upgrade a local match because some unrelated CI attestation exists', () => {
    // Reading the strongest provenance in the whole set answers "is anything
    // here CI-attested" instead of "was the thing that matched CI-attested".
    const all = [local(HASH_A), ci(HASH_B)]
    const verdict = gradeMatchProvenance([local(HASH_A)], all)

    expect(verdict.grade).toBe('ci-disagrees')
    expect(verdict.presentableAsAttested).toBe(false)
  })

  it('says how many CI attestations disagreed', () => {
    // A signer's next question is whether one build drifted or the whole set
    // is elsewhere, and the count is the cheapest part of that answer.
    const verdict = gradeMatchProvenance(
      [local(HASH_A)],
      [local(HASH_A), ci(HASH_B), ci(HASH_B)]
    )

    expect(verdict.reason).toContain('2 CI attestation')
  })

  it('grades an empty matched set as unattested rather than throwing', () => {
    // A caller that skipped the comparison must not be able to get a pass here.
    const verdict = gradeMatchProvenance([], [ci(HASH_B)])

    expect(verdict.grade).toBe('unattested')
    expect(verdict.presentableAsAttested).toBe(false)
  })

  it('refuses a matched build whose masked hash is not a digest', () => {
    // A malformed hash compares as readily as a real one, so without this the
    // verdict rests on a comparison between two values that are not hashes.
    for (const bad of ['', '0x', `0x${'aa'.repeat(16)}`, '0xzz']) {
      const verdict = gradeMatchProvenance([ci(bad)], [ci(bad)])

      expect(verdict.grade).toBe('malformed')
      expect(verdict.presentableAsAttested).toBe(false)
    }
  })

  it('does not let a malformed attestation elsewhere in the set refuse a good match', () => {
    // The guard asks about the matched builds only. Widened to the whole set, a
    // corrupt record nobody matched would block a legitimate CI attestation.
    const verdict = gradeMatchProvenance([ci(HASH_A)], [ci(HASH_A), ci('0x')])

    expect(verdict.grade).toBe('ci-attested')
  })
})

describe('the grading agrees with the comparison it grades', () => {
  // The defect this pins: grading on masked hash alone is a weaker predicate
  // than the comparison's, so a CI attestation the comparison REJECTED was
  // counted as one that matched, and ci-disagrees could never fire.
  const LOCAL_RAW = `0x${'11'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic raw hash
  const CI_RAW = `0x${'22'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic raw hash

  // zkEVM pins rawHash, and the zksolc fork lives only in the trailer that
  // masking removes, so a CI mint on another fork reaches exactly this shape:
  // same masked hash, different exact bytes.
  const localBuild = local(HASH_A, {
    lineage: 'local (zksync)',
    rawHash: LOCAL_RAW,
  })
  const ciBuild = ci(HASH_A, {
    lineage: 'CI (zksync, other fork)',
    rawHash: CI_RAW,
  })

  it('grades a CI attestation the comparison rejected as ci-disagrees', () => {
    const all = [localBuild, ciBuild]
    const comparison = compareToAttestedSet(
      {
        maskedHash: HASH_A,
        rawByteLength: 1440,
        rawHash: LOCAL_RAW,
        maskedByteCount: 0,
      },
      all,
      { isClosedSet: true }
    )

    expect(comparison.verdict).toBe('MATCH')
    expect(comparison.matchedLineages).toEqual(['local (zksync)'])

    expect(comparison.matched).toEqual([localBuild])

    const verdict = gradeMatchProvenance(comparison.matched, all)

    expect(verdict.presentableAsAttested).toBe(false)
    expect(verdict.grade).toBe('ci-disagrees')
  })

  it('holds when the two builds share a lineage', () => {
    // `describeLineage` carries no provenance marker, so a CI mint and a local
    // rebuild of one contract at one commit under one profile collide. Re-deriving
    // the matched set from `matchedLineages` re-admits the rejected CI build and
    // grades this ci-attested; taking `comparison.matched` cannot.
    const shared =
      'AcrossFacet@1.0.0 rebuilt at abc123def (zksync: zksolc 1.5.11, solc 0.8.28)'
    const all = [
      local(HASH_A, { lineage: shared, rawHash: LOCAL_RAW }),
      ci(HASH_A, { lineage: shared, rawHash: CI_RAW }),
    ]
    const comparison = compareToAttestedSet(
      {
        maskedHash: HASH_A,
        rawByteLength: 1440,
        rawHash: LOCAL_RAW,
        maskedByteCount: 0,
      },
      all,
      { isClosedSet: true }
    )

    expect(comparison.verdict).toBe('MATCH')
    expect(comparison.matched).toHaveLength(1)
    expect(
      all.filter((candidate) =>
        comparison.matchedLineages.includes(candidate.lineage)
      )
    ).toHaveLength(2)

    const verdict = gradeMatchProvenance(comparison.matched, all)

    expect(verdict.grade).toBe('ci-disagrees')
    expect(verdict.presentableAsAttested).toBe(false)
  })
})
