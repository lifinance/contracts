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
 * The sharp case is neither of those. When CI has attested this contract and
 * the deployed code matches only the local rebuild, CI and this host disagree
 * about what the source compiles to. That is not a weaker pass; it is the one
 * outcome here that a signer must not see rendered as any kind of pass.
 *
 * This module is handed the builds the comparison matched and never re-derives
 * that set. A predicate weaker than the comparison's — masked hash alone, where
 * the comparison also requires the deployed length and, on a pinned
 * attestation, the exact bytes — would read provenance off builds the
 * comparison rejected, and `ci-disagrees` could then never fire: the CI
 * attestation that failed to match would be counted as one that matched.
 */

import type { IAttestedBuild } from './attested-set'
import { digestFault } from './hex'

/**
 * How the match should be described to a signer.
 *
 * - `ci-attested` — the matched build was attested by CI.
 * - `locally-rebuilt` — matched a local rebuild, and CI has attested nothing
 *   for this contract, so there is no second opinion to have disagreed.
 * - `ci-disagrees` — matched a local rebuild *while* CI attestations exist and
 *   none of them match. Either CI built something else or this host did.
 * - `unattested` — nothing in the set matched.
 * - `malformed` — a matched build carries a masked hash that is not a digest,
 *   so whatever the comparison compared cannot be trusted to be a hash.
 */
export type AttestationGrade =
  | 'ci-attested'
  | 'locally-rebuilt'
  | 'ci-disagrees'
  | 'unattested'
  | 'malformed'

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
 * Never a substitute for the comparison itself. Pass the builds
 * `compareToAttestedSet` actually matched as `matched`; `all` is consulted only
 * to count CI attestations that did *not* match, which is invisible from the
 * matched subset alone.
 *
 * An empty `matched` grades `unattested` rather than throwing, so a caller that
 * has not run the comparison cannot obtain a pass from this module by accident.
 * @param matched - The builds the comparison found the deployed code equal to
 * @param all - Every attestation for this contract, both provenances
 * @returns The grade, whether it may be shown as attested, and why
 */
export const gradeMatchProvenance = (
  matched: readonly IAttestedBuild[],
  all: readonly IAttestedBuild[]
): IProvenanceVerdict => {
  if (matched.length === 0)
    return {
      grade: 'unattested',
      presentableAsAttested: false,
      reason: `no attested build matched the deployed code (${all.length} attestation(s) considered)`,
    }

  // A malformed hash normalises and compares as readily as a real one, so a
  // corrupt record reaching this point would otherwise be graded on the
  // strength of a comparison between two values that are not hashes.
  const malformed = matched.find(
    (build) => digestFault(build.maskedHash, 'masked hash') !== undefined
  )
  if (malformed)
    return {
      grade: 'malformed',
      presentableAsAttested: false,
      reason: `the build matched from ${
        malformed.lineage
      } carries an unusable masked hash: ${digestFault(
        malformed.maskedHash,
        'masked hash'
      )}`,
    }

  if (matched.some((build) => build.provenance === 'A-CI'))
    return {
      grade: 'ci-attested',
      presentableAsAttested: true,
      reason: 'the deployed code matches a build CI attested',
    }

  const ciCount = all.filter((build) => build.provenance === 'A-CI').length
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
