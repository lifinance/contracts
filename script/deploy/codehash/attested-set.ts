/**
 * Layer 1 of the codehash check: is the deployed code a hash this repo built?
 *
 * Import this after normalising code with `stripMetadataTrailer` and
 * `maskImmutables`. The comparison is set membership against every attested
 * build, never equality against one record- or network-derived profile.
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
   * Decoded from the deployed code's own trailer, so chosen by whoever deployed
   * it. Absent when no version can be read.
   */
  solcVersion?: string
}

/** How completely the attested set describes what this contract may be. */
export interface ILineageScope {
  /**
   * True when `attested` enumerates every toolchain the contract can
   * legitimately have been built with, so code matching none of them is not a
   * build of main. Derive it from repo configuration — the network's declared
   * EVM version and whether it is zkEVM — and never from the deployed
   * bytecode, which the proposer controls.
   */
  isClosedSet: boolean
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
  (/^0x/i.test(hash) ? hash.slice(2) : hash).toLowerCase()

const blocked = (
  verdict: 'MISMATCH' | 'UNVERIFIABLE',
  reason: string
): ICodehashComparison => ({
  verdict,
  matchedLineages: [],
  reason,
  blocksSigning: true,
})

/**
 * Grades deployed code against the builds this repo can vouch for.
 *
 * Three verdicts, because a gate whose red means "we could not tell" is one
 * signers learn to click through. MISMATCH is a statement about the code;
 * UNVERIFIABLE is a statement about our knowledge. Both block.
 *
 * Known limitation, and the reason `scope` exists: with an open set, the only
 * thing distinguishing "we never built that toolchain" from "this is not our
 * code" is the compiler version in the deployed trailer, which the proposer
 * writes. An open-set MISMATCH can therefore be moved to UNVERIFIABLE by three
 * bytes. A closed set does not consult the trailer at all.
 *
 * @param observed - The code found on chain, already stripped and masked.
 * @param attested - Every attested build for this contract. Order is irrelevant.
 * @param scope - Whether `attested` is the complete set of legitimate builds.
 * @returns The verdict, the lineages that matched, and why.
 */
export const compareToAttestedSet = (
  observed: IObservedCode,
  attested: IAttestedBuild[],
  scope: ILineageScope
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
    return blocked(
      'UNVERIFIABLE',
      'no attested build of main is available for this contract, so nothing can be compared'
    )

  // With the legitimate set complete, non-membership settles it on its own and
  // nothing the deployed bytecode says about itself can soften the verdict.
  if (scope.isClosedSet)
    return blocked(
      'MISMATCH',
      `the deployed code matches none of the ${attested.length} builds this contract can legitimately have, so it is not a build of main`
    )

  if (!observed.solcVersion)
    return blocked(
      'UNVERIFIABLE',
      'the deployed code carries no readable compiler version, and the set of legitimate builds is open, so its lineage cannot be established'
    )

  const builtVersions = new Set(attested.map((build) => build.solcVersion))
  if (!builtVersions.has(observed.solcVersion))
    return blocked(
      'UNVERIFIABLE',
      `the deployed code reports solc ${
        observed.solcVersion
      }, which no attested build used (${[...builtVersions]
        .sort()
        .join(', ')}), and the set of legitimate builds is open`
    )

  return blocked(
    'MISMATCH',
    `the deployed code does not match any attested build, including the ${
      observed.solcVersion
    } one it reports (${attested.length} build${
      attested.length === 1 ? '' : 's'
    } compared)`
  )
}
