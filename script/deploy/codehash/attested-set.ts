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
  /** Length of the code as deployed, before anything was stripped or masked. */
  rawByteLength: number
  /**
   * keccak of the exact deployed bytes, or undefined to compare on the
   * normalised form alone. Pass it when the attestation pins exact bytes.
   */
  rawHash: string | undefined
}

/** What was actually found at the address, normalised the same way. */
export interface IObservedCode {
  maskedHash: string
  /** Length of the code as deployed, before anything was stripped or masked. */
  rawByteLength: number
  /** keccak of the exact deployed bytes. */
  rawHash: string
  /**
   * How many bytes were excluded from `maskedHash` as immutables. A MATCH says
   * nothing about them, so a caller that has not run layer 2 must not render an
   * unqualified green.
   */
  maskedByteCount: number
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
  /**
   * Bytes the comparison did not look at, because they hold immutables. Nonzero
   * means this verdict is incomplete until layer 2 has checked their values.
   */
  excludedByteCount: number
  /** True for everything but MATCH. Render the verdict, never this flag. */
  blocksSigning: boolean
}

const normalizeHash = (hash: string): string =>
  (/^0x/i.test(hash) ? hash.slice(2) : hash).toLowerCase()

const blocked = (
  verdict: 'MISMATCH' | 'UNVERIFIABLE',
  reason: string,
  excludedByteCount: number
): ICodehashComparison => ({
  verdict,
  matchedLineages: [],
  reason,
  excludedByteCount,
  blocksSigning: true,
})

/**
 * Grades deployed code against the builds this repo can vouch for.
 *
 * Three verdicts, because a gate whose red means "we could not tell" is one
 * signers learn to click through. MISMATCH is a statement about the code;
 * UNVERIFIABLE is a statement about our knowledge. Both block.
 *
 * A match requires the normalised hash AND the deployed length: the hash alone
 * leaves the trailer's length word free, and that word decides how much is
 * removed before hashing, so appending a payload and a length word covering it
 * normalises to whatever prefix the appender likes.
 *
 * What both together still allow, measured on a 1440-byte facet with a 53-byte
 * trailer: 47 bytes of arbitrary content inside the trailer region, where an
 * honest build carries a 34-byte digest. It is unreachable because `src/` holds
 * no internal function pointers, so no dynamic jump can be steered into it —
 * NOT because it follows the code's terminating INVALID, which two artifacts in
 * the fleet do not have (their code ends in EIP-712 type-string data).
 *
 * Pass `rawHash` to close that window: an attestation that pins the exact
 * deployed bytes leaves nothing free. The cost is that metadata-level drift
 * between the deployed source and the attested one — a comment, a file path —
 * then reads as a MISMATCH, which is the reason stripping exists. The caller
 * states which it wants; this module does not choose.
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
  const sameCode = attested.filter(
    (build) => normalizeHash(build.maskedHash) === target
  )
  const sameLength = sameCode.filter(
    (build) => build.rawByteLength === observed.rawByteLength
  )
  const exact = sameLength.filter(
    (build) =>
      build.rawHash === undefined ||
      normalizeHash(build.rawHash) === normalizeHash(observed.rawHash)
  )

  if (exact.length > 0) {
    const matchedLineages = exact.map((build) => build.lineage)
    return {
      verdict: 'MATCH',
      matchedLineages,
      reason:
        observed.maskedByteCount === 0
          ? `code matches the attested build from ${matchedLineages.join(
              ' and '
            )}`
          : `code matches the attested build from ${matchedLineages.join(
              ' and '
            )} outside its immutables; the ${
              observed.maskedByteCount
            } bytes holding those were not compared and their values still have to be checked`,
      excludedByteCount: observed.maskedByteCount,
      blocksSigning: false,
    }
  }

  // Only reachable for an attestation that pins exact bytes: the code agrees
  // everywhere the comparison looks, and the bytes it does not look at do not.
  if (sameLength.length > 0)
    return blocked(
      'MISMATCH',
      `the deployed code is identical to the attested build from ${sameLength[0]?.lineage} outside its metadata trailer, and that trailer's bytes differ from the attested ones`,
      observed.maskedByteCount
    )

  // Normalising to an attested build is not the same as being one. The trailer's
  // length word says how many bytes come off before hashing, and it is part of
  // the deployed code, so appending a payload and a length word covering it
  // normalises to whatever prefix the appender likes.
  if (sameCode.length > 0) {
    const attestedLength = sameCode[0]?.rawByteLength ?? 0
    return blocked(
      'MISMATCH',
      `the deployed code normalises to the attested build from ${
        sameCode[0]?.lineage
      } but is ${
        observed.rawByteLength
      } bytes where that build is ${attestedLength}, so ${Math.abs(
        observed.rawByteLength - attestedLength
      )} bytes of it are not accounted for`,
      observed.maskedByteCount
    )
  }

  if (attested.length === 0)
    return blocked(
      'UNVERIFIABLE',
      'no attested build of main is available for this contract, so nothing can be compared',
      observed.maskedByteCount
    )

  // With the legitimate set complete, non-membership settles it on its own and
  // nothing the deployed bytecode says about itself can soften the verdict.
  if (scope.isClosedSet)
    return blocked(
      'MISMATCH',
      `the deployed code matches none of the ${attested.length} builds this contract can legitimately have, so it is not a build of main`,
      observed.maskedByteCount
    )

  if (!observed.solcVersion)
    return blocked(
      'UNVERIFIABLE',
      'the deployed code carries no readable compiler version, and the set of legitimate builds is open, so its lineage cannot be established',
      observed.maskedByteCount
    )

  const builtVersions = new Set(attested.map((build) => build.solcVersion))
  if (!builtVersions.has(observed.solcVersion))
    return blocked(
      'UNVERIFIABLE',
      `the deployed code reports solc ${
        observed.solcVersion
      }, which no attested build used (${[...builtVersions]
        .sort()
        .join(', ')}), and the set of legitimate builds is open`,
      observed.maskedByteCount
    )

  return blocked(
    'MISMATCH',
    `the deployed code does not match any attested build, including the ${
      observed.solcVersion
    } one it reports (${attested.length} build${
      attested.length === 1 ? '' : 's'
    } compared)`,
    observed.maskedByteCount
  )
}
