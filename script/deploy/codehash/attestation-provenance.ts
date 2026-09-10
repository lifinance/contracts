/**
 * Which side built the thing the deployed code matched.
 *
 * `compareToAttestedSet` answers whether the deployed code is a build this repo
 * can vouch for. It does not answer *who* built it, and the two are not the
 * same claim: an attestation minted by CI was produced on a machine the signer
 * does not control, while a local rebuild was produced by the very host that
 * could be compromised. A gate that renders both as one green tells the signer
 * their own machine agreed with itself.
 *
 * The sharp case is neither. When CI has attested this contract and the
 * deployed code matches only the local rebuild, CI and this host disagree about
 * what the source compiles to. That is not a weaker pass; it is the one outcome
 * here that a signer must not see rendered as any kind of pass.
 */

import { normalizeHash } from './hex'

/** Who produced an attestation. */
export type AttestationProvenance = 'A-CI' | 'A-LOCAL'

/** One attestation, reduced to the two facts this grading needs. */
export interface IProvenancedAttestation {
  provenance: AttestationProvenance
  /** keccak of the runtime code after trailer-stripping and immutable masking. */
  maskedHash: string
}

/**
 * How the match should be described to a signer.
 *
 * - `ci-attested` — the matched build was attested by CI.
 * - `locally-rebuilt` — matched a local rebuild, and CI has attested nothing
 *   for this contract, so there is no second opinion to have disagreed.
 * - `ci-disagrees` — matched a local rebuild *while* CI attestations exist and
 *   none of them match. Either CI built something else or this host did.
 * - `unattested` — the hash matches nothing in the set.
 */
export type AttestationGrade =
  | 'ci-attested'
  | 'locally-rebuilt'
  | 'ci-disagrees'
  | 'unattested'

export interface IProvenanceVerdict {
  grade: AttestationGrade
  /**
   * Whether the match may be presented as CI-attested. Only `ci-attested` may.
   * A local rebuild is a fallback the signer has to see, and `ci-disagrees` is
   * a finding rather than a weaker pass. Render the grade, never this flag.
   */
  presentableAsAttested: boolean
  /** One line naming what was compared, for the signer-facing report. */
  reason: string
}

/**
 * Grades a codehash match by who built the attestation it matched.
 *
 * Never a substitute for the comparison itself — pass the hash the comparison
 * already matched. Hashes are compared through `normalizeHash`, the same
 * canonical form `compareToAttestedSet` uses, so a pair that comparison called
 * a match cannot read as a different hash here.
 *
 * A hash matching nothing grades `unattested` rather than throwing, so a caller
 * that has not run the comparison cannot obtain a pass from this module by
 * accident.
 * @param matchedHash - Masked hash the deployed code was found to equal
 * @param attestations - Every attestation in the set, both provenances
 * @returns The grade, whether it may be shown as attested, and why
 */
export const gradeMatchProvenance = (
  matchedHash: string,
  attestations: readonly IProvenancedAttestation[]
): IProvenanceVerdict => {
  const target = normalizeHash(matchedHash)
  const matching = attestations.filter(
    (entry) => normalizeHash(entry.maskedHash) === target
  )

  if (matching.length === 0)
    return {
      grade: 'unattested',
      presentableAsAttested: false,
      reason: `no attestation in the set carries this masked hash (${attestations.length} attestation(s) considered)`,
    }

  if (matching.some((entry) => entry.provenance === 'A-CI'))
    return {
      grade: 'ci-attested',
      presentableAsAttested: true,
      reason: 'the deployed code matches a build CI attested',
    }

  // Asked of the whole set, not of the matching subset: the question is whether
  // a CI attestation exists *and failed to match*, which is invisible if only
  // the matches are examined.
  const ciCount = attestations.filter(
    (entry) => entry.provenance === 'A-CI'
  ).length
  if (ciCount > 0)
    return {
      grade: 'ci-disagrees',
      presentableAsAttested: false,
      reason: `the deployed code matches a local rebuild, but none of the ${ciCount} CI attestation(s) for this contract match it`,
    }

  return {
    grade: 'locally-rebuilt',
    presentableAsAttested: false,
    reason:
      'the deployed code matches a local rebuild, and CI has attested nothing for this contract to compare against',
  }
}
