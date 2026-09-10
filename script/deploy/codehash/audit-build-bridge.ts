/**
 * The bridge between an audit and the build that was deployed.
 *
 * `audit/auditLog.json` records who audited what and when, and nothing about
 * the compiler. That gap is real: facets routinely ship under the solc-floor
 * profile while their networks declare cancun, so a contract audited under one
 * compiler and deployed under another is invisible in the log today (A6).
 *
 * The fix is forward-only — no fleet re-audit, no redeploy — and it rests on
 * three moves:
 *
 * - **Audits stay version-agnostic.** An audit is of source, so it is not
 *   invalidated by a different compiler. What needs review is the *compiler
 *   set*, vetted once per profile against solc and zksolc advisories.
 *   Adopting a new compiler version is therefore the only review event, and
 *   {@link VETTED_COMPILER_SETS} is where it happens.
 * - **`sourceClosureHash` proves the build compiled the audited source** over
 *   the full transitive closure. A diff of the facet file alone misses a
 *   swapped library — the `AcrossV4SwapFacet`/`LibAsset` case — which is why
 *   the closure and not the file is the unit (E1).
 * - **Everything here is a NOTE, never a block.** A per-deploy version gate
 *   would brand every london-chain deploy unaudited, which is a false red on
 *   routine work. The failure this module must avoid is refusing honest
 *   deploys, not permitting dishonest ones — the codehash gate is what
 *   refuses.
 */

/** A compiler set that has been vetted against advisories and blessed. */
export interface IVettedCompilerSet {
  solcVersion: string
  evmVersion: string
  /**
   * Present exactly for a zkEVM profile. The fork and LLVM versions float
   * independently of the zksolc release, so a zk set is not identified by its
   * zksolc version alone.
   */
  zk?: {
    zksolcVersion: string
    solcForkVersion: string
    llvmVersion: string
  }
  /**
   * When this exact set was checked against known solc/zksolc advisories.
   *
   * Recorded rather than assumed: the claim being made is that somebody looked
   * at the advisories for these versions on that date, and a set with no date
   * has not been vetted whatever else is known about it.
   */
  vettedOn: string
}

/**
 * The compiler sets this repository has blessed, by Foundry profile.
 *
 * Editing this map **is** the review event. Adding a version here asserts that
 * its advisories were read, so a build under a profile absent from this map is
 * reported rather than silently accepted — see {@link auditCoverageNotes}.
 *
 * Deliberately not derived from `foundry.toml`. Reading the profile's current
 * version would make this map agree with whatever the repo happens to pin
 * today, which is the opposite of a review record: bumping the pin would
 * silently bless the new compiler.
 */
export const VETTED_COMPILER_SETS: Readonly<
  Record<string, IVettedCompilerSet>
> = {
  default: {
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
    vettedOn: '2026-09-09',
  },
  solc_floor: {
    solcVersion: '0.8.17',
    evmVersion: 'london',
    vettedOn: '2026-09-09',
  },
  zksync: {
    solcVersion: '0.8.29',
    evmVersion: 'cancun',
    zk: {
      zksolcVersion: '1.5.15',
      solcForkVersion: '0.8.29',
      llvmVersion: '1.0.2',
    },
    vettedOn: '2026-09-09',
  },
}

/** What was actually deployed, as the record describes it. */
export interface IDeployedBuild {
  contractName: string
  version: string
  /** Foundry profile the deploy built under. */
  profile: string
  solcVersion: string
  evmVersion: string
  zk?: {
    zksolcVersion: string
    solcForkVersion: string
    llvmVersion: string
  }
  /**
   * The closure the attested build compiled, when one is recorded. Absent for
   * anything built before attestations existed.
   */
  sourceClosureHash?: string
}

/** What the audit log says, reduced to the two questions asked of it. */
export interface IAuditRecord {
  /** Audit ids covering this contract at this version; empty when none do. */
  auditIds: readonly string[]
  /**
   * The closure the auditor read, when the audit records one. Absent for every
   * audit predating the field, which is most of them — the bridge is
   * forward-only.
   */
  sourceClosureHash?: string
}

/**
 * Why a deployed build is not fully bridged to its audit.
 *
 * Stable strings: they are rendered to a signer and matched by callers.
 *
 * - `no-audit-recorded` — the log names no audit for this contract at this
 *   version.
 * - `profile-not-vetted` — the build ran under a profile whose compiler set is
 *   not in the vetted map, so no one has checked its advisories.
 * - `compiler-set-differs` — the profile is vetted, but the build reports
 *   different versions than the vetted set, so what ran is not what was
 *   reviewed.
 * - `closure-unrecorded` — one side records no `sourceClosureHash`, usually
 *   the audit since most predate the field, so the bridge cannot be proved,
 *   only assumed.
 * - `closure-differs` — both sides record a closure and they disagree, so the
 *   audited source is not the source that was built.
 */
export type AuditBridgeNote =
  | 'no-audit-recorded'
  | 'profile-not-vetted'
  | 'compiler-set-differs'
  | 'closure-unrecorded'
  | 'closure-differs'

/** One note, with the sentence a signer reads. */
export interface IAuditBridgeNote {
  note: AuditBridgeNote
  detail: string
}

/**
 * The versions a set was reviewed at, as a signer reads them.
 *
 * The zk half is spelled out because a zk mismatch is usually only in the zk
 * half: rendering solc alone prints two identical strings either side of a
 * "but", which reads as a note about nothing.
 */
const describeCompilerSet = (set: {
  solcVersion: string
  evmVersion: string
  zk?: { zksolcVersion: string; solcForkVersion: string; llvmVersion: string }
}): string =>
  set.zk === undefined
    ? `solc ${set.solcVersion}/${set.evmVersion}`
    : `solc ${set.solcVersion}/${set.evmVersion}, zksolc ${set.zk.zksolcVersion} (solc fork ${set.zk.solcForkVersion}, LLVM ${set.zk.llvmVersion})`

const sameZk = (
  a: IVettedCompilerSet['zk'],
  b: IDeployedBuild['zk']
): boolean => {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  return (
    a.zksolcVersion === b.zksolcVersion &&
    a.solcForkVersion === b.solcForkVersion &&
    a.llvmVersion === b.llvmVersion
  )
}

/**
 * Everything worth telling a signer about the audit behind a deployed build.
 *
 * Never a verdict and never empty of meaning: an empty array says the build was
 * audited, ran under a reviewed compiler set, and compiled the source the
 * auditor read. Anything else is a note the signer weighs, because the audit
 * bridge is not a gate — the codehash comparison is.
 *
 * Notes accumulate rather than short-circuit, so a build that is both
 * unaudited and built under an unvetted compiler says both. One note hiding
 * another is how a signer comes to believe the lesser problem is the only one.
 * @param build - The deployed build, as its record describes it
 * @param audit - What the audit log says about that contract and version
 * @returns Every note that applies, in a fixed order
 */
export const auditCoverageNotes = (
  build: IDeployedBuild,
  audit: IAuditRecord
): IAuditBridgeNote[] => {
  const notes: IAuditBridgeNote[] = []

  if (audit.auditIds.length === 0)
    notes.push({
      note: 'no-audit-recorded',
      detail: `no audit is recorded for ${build.contractName} at v${build.version}`,
    })

  // A plain property read resolves a profile named `toString` against
  // Object.prototype and hands back a set nobody vetted.
  const vetted = Object.prototype.hasOwnProperty.call(
    VETTED_COMPILER_SETS,
    build.profile
  )
    ? VETTED_COMPILER_SETS[build.profile]
    : undefined
  if (vetted === undefined)
    notes.push({
      note: 'profile-not-vetted',
      detail: `the ${build.profile} profile is not in the vetted compiler map, so its solc/zksolc advisories have not been reviewed`,
    })
  else if (
    vetted.solcVersion !== build.solcVersion ||
    vetted.evmVersion !== build.evmVersion ||
    !sameZk(vetted.zk, build.zk)
  )
    // The profile name agreeing is not the compiler set agreeing: a pin can
    // move under a profile that keeps its name, and then what ran is not what
    // was reviewed.
    notes.push({
      note: 'compiler-set-differs',
      detail: `${build.profile} was vetted at ${describeCompilerSet(
        vetted
      )} on ${vetted.vettedOn}, but this build reports ${describeCompilerSet(
        build
      )}`,
    })

  // Closure notes are about the bridge itself, so they apply whether or not an
  // audit is recorded — an audit that records no closure is exactly the state
  // this module exists to make visible.
  if (
    audit.sourceClosureHash === undefined ||
    build.sourceClosureHash === undefined
  )
    notes.push({
      note: 'closure-unrecorded',
      detail:
        'the audit or the build records no source closure, so the audited source cannot be shown to be the source that was built',
    })
  else if (audit.sourceClosureHash !== build.sourceClosureHash)
    notes.push({
      note: 'closure-differs',
      detail:
        'the audit and the build record different source closures, so the audited source is not the source that was built — a swapped library changes the closure without changing the facet file',
    })

  return notes
}

/**
 * Whether a build is fully bridged to its audit.
 *
 * A convenience over {@link auditCoverageNotes} for a caller rendering a single
 * marker. **It is not a gate**: a false here means "tell the signer", never
 * "refuse the deploy".
 * @param build - The deployed build
 * @param audit - What the audit log says
 * @returns True only when no note applies
 */
export const isFullyBridged = (
  build: IDeployedBuild,
  audit: IAuditRecord
): boolean => auditCoverageNotes(build, audit).length === 0
