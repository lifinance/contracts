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

import {
  gradeMatchProvenance,
  type IProvenancedAttestation,
} from './attestation-provenance'

const HASH_A = `0x${'aa'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic masked hash
const HASH_B = `0x${'bb'.repeat(32)}` // pre-commit-checker: not a secret — a synthetic masked hash

const ci = (maskedHash: string): IProvenancedAttestation => ({
  provenance: 'A-CI',
  maskedHash,
})
const local = (maskedHash: string): IProvenancedAttestation => ({
  provenance: 'A-LOCAL',
  maskedHash,
})

describe('gradeMatchProvenance', () => {
  it('presents a CI-attested match as attested', () => {
    // The paired present: the grading can say yes, so every refusal below
    // means something.
    const verdict = gradeMatchProvenance(HASH_A, [ci(HASH_A)])

    expect(verdict.grade).toBe('ci-attested')
    expect(verdict.presentableAsAttested).toBe(true)
  })

  it('never presents a local rebuild as attested', () => {
    const verdict = gradeMatchProvenance(HASH_A, [local(HASH_A)])

    expect(verdict.grade).toBe('locally-rebuilt')
    expect(verdict.presentableAsAttested).toBe(false)
  })

  it('does not upgrade a local match because some unrelated CI attestation exists', () => {
    // Reading the strongest provenance present in the set answers "is anything
    // here CI-attested" instead of "was the thing that matched CI-attested".
    const verdict = gradeMatchProvenance(HASH_A, [local(HASH_A), ci(HASH_B)])

    expect(verdict.grade).toBe('ci-disagrees')
    expect(verdict.presentableAsAttested).toBe(false)
  })

  it('says how many CI attestations disagreed', () => {
    // A signer's next question is whether one build drifted or the whole set
    // is elsewhere, and the count is the cheapest part of that answer.
    const verdict = gradeMatchProvenance(HASH_A, [
      local(HASH_A),
      ci(HASH_B),
      ci(HASH_B),
    ])

    expect(verdict.reason).toContain('2 CI attestation')
  })

  it('grades a hash matching nothing as unattested rather than throwing', () => {
    // A caller that skipped the comparison must not be able to get a pass here.
    const verdict = gradeMatchProvenance(HASH_A, [ci(HASH_B)])

    expect(verdict.grade).toBe('unattested')
    expect(verdict.presentableAsAttested).toBe(false)
  })

  it('grades an empty set as unattested', () => {
    const verdict = gradeMatchProvenance(HASH_A, [])

    expect(verdict.grade).toBe('unattested')
    expect(verdict.presentableAsAttested).toBe(false)
  })

  it('matches the same hash written in a different case', () => {
    // Hex is case-insensitive, so folding case compares a value to itself. If
    // it did not, an uppercase CI attestation would fail to match and the
    // verdict would drop to ci-disagrees — a false alarm about a build that
    // agrees perfectly.
    const verdict = gradeMatchProvenance(HASH_A.toUpperCase(), [ci(HASH_A)])

    expect(verdict.grade).toBe('ci-attested')
  })

  it('matches across a 0x prefix the comparison already treats as the same hash', () => {
    // `compareToAttestedSet` normalises the prefix away, so it calls these a
    // match. Grading them apart reads a CI-attested build as unattested — and,
    // with a local rebuild carrying the prefixed form, as CI disagreeing about
    // a build CI attested exactly.
    const bare = HASH_A.slice(2)

    expect(gradeMatchProvenance(HASH_A, [ci(bare)]).grade).toBe('ci-attested')
    expect(gradeMatchProvenance(bare, [ci(HASH_A)]).grade).toBe('ci-attested')
    expect(gradeMatchProvenance(HASH_A, [local(HASH_A), ci(bare)]).grade).toBe(
      'ci-attested'
    )
  })
})
