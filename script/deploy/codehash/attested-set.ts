/**
 * Layer 1 of the codehash primitive: does the deployed code hash to something
 * this repo is known to have built?
 *
 * The comparison is SET MEMBERSHIP against every attested build of main for this
 * contract, never equality against one profile derived from the deployment
 * record or from the network. One source legitimately produces different
 * bytecode per build lineage — the repo's own `AccessManagerFacet` hashes
 * differently at solc 0.8.29 / cancun and at the 0.8.17 / london floor — so a
 * single expected value turns honest builds red, and a signer who has seen red
 * on an honest proposal will wave through the dishonest one.
 *
 * Three verdicts, because collapsing them is what makes a gate ignorable:
 *
 * - MATCH — the hash is one we built.
 * - MISMATCH — it is not, and we DID build the lineage the code claims, so the
 *   disagreement is evidence about the code.
 * - UNVERIFIABLE — we cannot tell: no lineage to compare within, or nothing
 *   attested. This blocks too (fail closed on unexplained), but it is a
 *   statement about our knowledge, not about the code.
 */

/** A build of main this repo can vouch for, produced locally or in CI. */
export interface IAttestedBuild {
  /** Human label for the toolchain, e.g. `upstream cancun`. */
  lineage: string
  /** Read from the build's own metadata trailer, never from a record. */
  solcVersion: string
  /** keccak of the runtime code after trailer-stripping and immutable masking. */
  maskedHash: string
}

/** What was actually found at the address, normalised the same way. */
export interface IObservedCode {
  maskedHash: string
  /**
   * Decoded from the deployed code's own trailer. Absent when there is no
   * readable trailer, which is itself a reason not to claim a verdict.
   */
  solcVersion?: string
}

export type CodehashVerdict = 'MATCH' | 'MISMATCH' | 'UNVERIFIABLE'

export interface ICodehashComparison {
  verdict: CodehashVerdict
  /** Every attested lineage reaching this hash, in the order given. */
  matchedLineages: string[]
  /** One line a signer can act on. */
  reason: string
  /** True for everything but MATCH. Render the verdict, never this flag. */
  blocksSigning: boolean
}

const normalizeHash = (hash: string): string =>
  (hash.startsWith('0x') ? hash.slice(2) : hash).toLowerCase()

/**
 * @param observed - The code found on chain, already stripped and masked.
 * @param attested - Every build of main for this contract. Order is irrelevant.
 */
export const compareToAttestedSet = (
  observed: IObservedCode,
  attested: IAttestedBuild[]
): ICodehashComparison => {
  const target = normalizeHash(observed.maskedHash)
  const matchedLineages = attested
    .filter((build) => normalizeHash(build.maskedHash) === target)
    .map((build) => build.lineage)

  if (matchedLineages.length > 0)
    return {
      verdict: 'MATCH',
      matchedLineages,
      reason: `code matches the attested build from ${matchedLineages.join(
        ' and '
      )}`,
      blocksSigning: false,
    }

  if (attested.length === 0)
    return {
      verdict: 'UNVERIFIABLE',
      matchedLineages: [],
      reason:
        'no attested build of main is available for this contract, so nothing can be compared',
      blocksSigning: true,
    }

  if (!observed.solcVersion)
    return {
      verdict: 'UNVERIFIABLE',
      matchedLineages: [],
      reason:
        'the deployed code carries no readable compiler version, so its build lineage cannot be established',
      blocksSigning: true,
    }

  // The distinction that keeps RED meaningful: a non-match only tells us about
  // the code if we built the lineage the code says it came from.
  const builtVersions = new Set(attested.map((build) => build.solcVersion))
  if (!builtVersions.has(observed.solcVersion))
    return {
      verdict: 'UNVERIFIABLE',
      matchedLineages: [],
      reason: `the deployed code was built with solc ${
        observed.solcVersion
      }, which no attested build used (${[...builtVersions]
        .sort()
        .join(', ')}), so a non-match proves nothing`,
      blocksSigning: true,
    }

  return {
    verdict: 'MISMATCH',
    matchedLineages: [],
    reason: `the deployed code does not match any attested build, including the ${
      observed.solcVersion
    } one it claims to come from (${attested.length} build${
      attested.length === 1 ? '' : 's'
    } compared)`,
    blocksSigning: true,
  }
}
