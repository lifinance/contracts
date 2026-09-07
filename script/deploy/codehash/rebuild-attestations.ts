/**
 * The attestation source the sign-time codehash gate compares against: a local
 * rebuild at the deployment record's commit, under every toolchain the network's
 * config says is legitimate.
 *
 * Import this to build the `attestationsFor` dependency of
 * {@link verifyCutTargets}. WP-5.2 turns the same answer into a lookup later; it
 * is not a prerequisite, because a rebuild answers the question today.
 *
 * Three shapes of the problem decide the design.
 *
 * **The record supplies the commit, never the toolchain.** Fourteen production
 * slots record `0.8.29` for code the compiler stamped `0.8.17`, so a profile
 * taken from the record would grade honest deploys rogue. The legitimate pairs
 * come from {@link deriveToolchainScope}, and every one of them is rebuilt, so
 * the gate downstream does set membership rather than equality against one
 * record-derived profile.
 *
 * **The deployed trailer never selects what to rebuild with.** Those bytes are
 * written by whoever proposes the cut: one flipped code byte plus three trailer
 * bytes claiming solc 0.8.99 moved a real verdict from MISMATCH to the softer
 * UNVERIFIABLE. The trailer read here is our *own* build's, which is why it may
 * name the version an attestation reports.
 *
 * **A rebuild that could not be performed is not "no attested build".** The two
 * are different facts with different remedies, and collapsing them turns an
 * infrastructure failure into a clean-looking grey — so an unreachable record
 * store, an unfetchable commit and a failed compile each surface as an
 * {@link AttestationSourceError}, while a record that is genuinely silent about
 * an address returns the empty set.
 */
import { keccak256, type Hex } from 'viem'

import type { IAttestedBuild } from './attested-set'
import { readMetadataTrailer, stripMetadataTrailer } from './bytecode-trailer'
import {
  ensureCommitAvailable,
  type ICommitAvailabilityDeps,
} from './commit-availability'
import { frameFault, strip0x } from './hex'
import { maskImmutables, type ImmutableReferences } from './immutable-offsets'
import type { IBuildProfile, IToolchainScope } from './lineage-scope'

/**
 * What `getCurrentGitCommitHash()` writes when it cannot read a commit. It is a
 * swallowed failure rather than a value, so it must not reach a fetch.
 */
const UNKNOWN_COMMIT = 'UNKNOWN'

/** The part of a deployment record this needs; the real rows carry far more. */
export interface IDeploymentRecordRef {
  contractName: string
  version: string
  /** Full 40-hex SHA, or empty/`UNKNOWN` on a record that predates the field. */
  gitCommitHash: string
}

export interface IRebuildRequest {
  contractName: string
  /** Full 40-hex SHA, already proven readable in this checkout. */
  commit: string
  profile: IBuildProfile
}

/** One compile's output, as the build runner read it out of `out/`. */
export interface IRebuiltArtifact {
  /** Runtime bytecode with its metadata trailer intact, `0x`-prefixed. */
  runtimeHex: string
  /** Foundry's `immutableReferences`; absent for a contract with none. */
  immutableReferences?: ImmutableReferences
}

export interface IAttestationSourceDeps {
  /**
   * Reads what the deployment record says is meant to be at an address.
   * MongoDB is the record: `deployments/_deployments_log_file.json` is stale by
   * years and omits recent contracts, so it is not a fallback. Throw when the
   * store cannot be reached — returning undefined would report an outage as a
   * clean "nothing is deployed here".
   */
  readRecord: (
    address: string,
    network: string
  ) => Promise<IDeploymentRecordRef | undefined>
  /** Which toolchains this network's code may legitimately have been built with. */
  toolchainScope: (network: string) => IToolchainScope
  /**
   * Compiles one contract at one commit under one profile. Throws on a failed
   * compile; a failure is never cached.
   */
  build: (request: IRebuildRequest) => IRebuiltArtifact
  git: ICommitAvailabilityDeps['git']
}

export type AttestationStage =
  | 'record-unreadable'
  | 'scope-unavailable'
  | 'commit-refused'
  | 'commit-unfetchable'
  | 'rebuild-failed'
  | 'artifact-unusable'

export type AttestationResolution =
  | {
      kind: 'built'
      /** One entry per legitimate lineage, in the order the scope gave them. */
      builds: IAttestedBuild[]
      /** True when the record's commit had to be fetched by SHA. */
      commitFetched: boolean
    }
  | {
      kind: 'unattestable'
      stage: 'no-record' | 'no-commit'
      reason: string
    }
  | { kind: 'error'; stage: AttestationStage; reason: string }

/**
 * Thrown by `attestationsFor` when the attestation set could not be established.
 *
 * Distinct from an empty set on purpose: the gate renders "we could not check"
 * and "there is nothing attested" as different UNVERIFIABLE reasons, and a
 * signer needs to know which of the two they are looking at.
 */
export class AttestationSourceError extends Error {
  public readonly stage: AttestationStage

  /**
   * @param stage - which step failed
   * @param reason - what failed, in one line
   */
  public constructor(stage: AttestationStage, reason: string) {
    super(reason)
    this.name = 'AttestationSourceError'
    this.stage = stage
  }
}

export interface INormalizedCode {
  ok: true
  /** keccak of the exact bytes, nothing stripped or masked. */
  rawHash: string
  /** Length as deployed, before anything was stripped or masked. */
  rawByteLength: number
  /** keccak after the trailer came off and immutables were zeroed. */
  maskedHash: string
  /** Bytes excluded as immutables. Always 0 on zkEVM, which inlines none. */
  maskedByteCount: number
}

export interface INormalizeRefused {
  ok: false
  reason: string
}

/**
 * Normalises runtime bytecode into the fields the comparison is made on.
 *
 * Both sides of the gate MUST go through this one function. The attested and
 * observed hashes are only comparable if the same bytes were removed from each,
 * and a second implementation of "strip then mask" is how two sides come to
 * normalise differently while both look finished.
 *
 * The trailer comes off before masking, so an immutable occurrence pointing into
 * it is refused rather than zeroing bytes the hash no longer covers.
 *
 * zkEVM takes no offset masking: its immutables live in `ImmutableSimulator`,
 * so an offset into the runtime code there points at real codegen and zeroing it
 * would blind the comparison to 32 bytes of code per immutable.
 *
 * @param runtimeHex - runtime bytecode, `0x`-prefixed, trailer intact
 * @param refs - Foundry's `immutableReferences`, or undefined when it has none
 * @param options.isZk - true for a zksolc lineage
 * @returns The hashes and lengths to compare, or why the bytes are unusable
 */
export const normalizeRuntimeCode = (
  runtimeHex: string,
  refs: ImmutableReferences | undefined,
  options: { isZk: boolean }
): INormalizedCode | INormalizeRefused => {
  const fault = frameFault(runtimeHex, 'bytecode')
  if (fault) return { ok: false, reason: fault }

  const exact = `0x${strip0x(runtimeHex)}` as Hex
  const rawByteLength = strip0x(exact).length / 2
  const rawHash = keccak256(exact)
  const { code } = stripMetadataTrailer(exact)

  if (options.isZk)
    return {
      ok: true,
      rawHash,
      rawByteLength,
      maskedHash: keccak256(code as Hex),
      maskedByteCount: 0,
    }

  const masked = maskImmutables(code, refs)
  if (!masked.ok) return { ok: false, reason: masked.reason }

  const maskedByteCount = Object.values(refs ?? {})
    .flat()
    .reduce((total, occurrence) => total + occurrence.length, 0)

  return {
    ok: true,
    rawHash,
    rawByteLength,
    maskedHash: keccak256(masked.code as Hex),
    maskedByteCount,
  }
}

/**
 * @param profile - the compiler pair a lineage was built under
 */
const isZkProfile = (profile: IBuildProfile): boolean =>
  profile.zksolcVersion !== undefined

/**
 * Names a lineage the way a signer will read it in a verdict.
 * @param record - the deployment record's contract identity
 * @param commit - the commit rebuilt at
 * @param profile - the compiler pair used
 * @param runtimeHex - what the rebuild produced, for its own trailer
 */
const describeLineage = (
  record: IDeploymentRecordRef,
  commit: string,
  profile: IBuildProfile,
  runtimeHex: string
): string => {
  const identity = `${record.contractName}@${
    record.version
  } rebuilt at ${commit.slice(0, 9)}`
  if (!isZkProfile(profile))
    return `${identity} (${profile.profile}: solc ${profile.solcVersion}, ${profile.evmVersion})`

  const trailer = readMetadataTrailer(runtimeHex)
  const toolchain = trailer.present ? trailer.toolchain : undefined
  // The LLVM fork is the one axis nothing in the record pins, and a fork bump is
  // exactly what a pinned comparison exists to catch, so it is named.
  const fork = toolchain ? `, llvm ${toolchain.llvmVersion}` : ''
  return `${identity} (${profile.profile}: zksolc ${
    profile.zksolcVersion
  }, solc ${toolchain?.solcVersion ?? profile.solcVersion}${fork})`
}

/**
 * Turns one rebuilt artifact into an attestation.
 *
 * `rawHash` is pinned on zkEVM and left unpinned elsewhere, and that is the
 * whole D19(b) decision in one line. The solc-fork/LLVM sub-version a zksolc
 * build was produced by lives only in the metadata trailer, so stripping the
 * trailer is precisely what makes fork drift invisible — measured on
 * `LayerSwapFacet`, where a 1.0.1→1.0.2 bump moved 33 trailer bytes and no
 * codegen. On EVM the trailer holds an IPFS digest of the source layout, which
 * moves for a changed comment, and pinning it there would block on drift that
 * cannot change behaviour.
 *
 * @param record - the record's contract identity
 * @param commit - the commit rebuilt at
 * @param profile - the compiler pair used
 * @param artifact - what the rebuild produced
 * @returns The attestation, or why the artifact is unusable
 */
const attestationFrom = (
  record: IDeploymentRecordRef,
  commit: string,
  profile: IBuildProfile,
  artifact: IRebuiltArtifact
): { ok: true; build: IAttestedBuild } | INormalizeRefused => {
  const isZk = isZkProfile(profile)
  const normalized = normalizeRuntimeCode(
    artifact.runtimeHex,
    artifact.immutableReferences,
    { isZk }
  )
  if (!normalized.ok) return normalized

  const trailer = readMetadataTrailer(artifact.runtimeHex)
  // This trailer is our own build output, not a proposer's, so reading it is
  // safe here in a way that reading the deployed one never is. The pin is the
  // fallback because 63 of 2,094 fleet slots carry no trailer at all.
  const solcVersion =
    (trailer.present ? trailer.solcVersion : undefined) ?? profile.solcVersion

  return {
    ok: true,
    build: {
      lineage: describeLineage(record, commit, profile, artifact.runtimeHex),
      solcVersion,
      maskedHash: normalized.maskedHash,
      rawByteLength: normalized.rawByteLength,
      rawHash: isZk ? normalized.rawHash : undefined,
    },
  }
}

export interface IAttestationSource {
  /** The full outcome, with the four cases kept apart. */
  resolve: (address: string, network: string) => Promise<AttestationResolution>
  /**
   * The seam {@link verifyCutTargets} consumes.
   * @throws AttestationSourceError when the set could not be established
   */
  attestationsFor: (
    address: string,
    network: string
  ) => Promise<IAttestedBuild[]>
}

/**
 * Builds an attestation source with a rebuild cache scoped to this run.
 *
 * A rebuild is minutes of compile, and one cut can gate several addresses of the
 * same contract, so an identical compile is not repeated. The cache cannot turn
 * a failing verdict into a passing one, by construction:
 *
 * - it is keyed on everything that determines the artifact — the address, the
 *   record's commit and the profile — so a hit can only ever substitute the
 *   compile it would have run;
 * - it holds artifacts, never verdicts. The deployed side is re-read and
 *   re-compared on every call, so a hit cannot widen the attested set or soften
 *   a comparison;
 * - only a successful rebuild is stored. A failure stays a failure to be
 *   retried, so a transient compile error cannot be remembered as one, and no
 *   cached entry can outlive the cause of a red.
 *
 * A Map rather than an object, so a key like `constructor` cannot be answered
 * by the prototype.
 *
 * @param deps - the record reader, scope resolver, build runner and git runner
 * @returns The resolver and the `attestationsFor` seam
 */
export const createAttestationSource = (
  deps: IAttestationSourceDeps
): IAttestationSource => {
  const cache = new Map<string, IAttestedBuild>()

  const resolve = async (
    address: string,
    network: string
  ): Promise<AttestationResolution> => {
    // Scope first: it is a pure config read, and an unresolvable network is a
    // whole-network condition no per-address record can remedy, so there is
    // nothing to gain from a record lookup that cannot lead anywhere.
    let scope: IToolchainScope
    try {
      scope = deps.toolchainScope(network)
    } catch (error) {
      return {
        kind: 'error',
        stage: 'scope-unavailable',
        reason: `${address} on ${network}: the toolchains its code may legitimately have been built with could not be established — ${message(
          error
        )}`,
      }
    }

    let record: IDeploymentRecordRef | undefined
    try {
      record = await deps.readRecord(address, network)
    } catch (error) {
      return {
        kind: 'error',
        stage: 'record-unreadable',
        reason: `${address} on ${network}: the deployment record could not be read, so what is meant to be at this address is unknown — ${message(
          error
        )}. The record is MongoDB; the checked-in deployment log is years stale and omits recent contracts, so it is not a fallback.`,
      }
    }

    if (record === undefined)
      return {
        kind: 'unattestable',
        stage: 'no-record',
        reason: `${address} on ${network}: the deployment record says nothing about this address, so there is no contract identity to rebuild.`,
      }

    const commit = record.gitCommitHash.trim()
    if (commit === '' || commit === UNKNOWN_COMMIT)
      return {
        kind: 'unattestable',
        stage: 'no-commit',
        reason: `${address} on ${network}: the record for ${record.contractName}@${record.version} carries no commit, so there is no source to rebuild from.`,
      }

    const availability = ensureCommitAvailable(commit, { git: deps.git })
    if (!availability.ok)
      return {
        kind: 'error',
        stage:
          availability.kind === 'refused'
            ? 'commit-refused'
            : 'commit-unfetchable',
        reason: `${address} on ${network}: ${availability.reason}`,
      }

    const builds: IAttestedBuild[] = []
    for (const profile of scope.profiles) {
      const key = `${address.toLowerCase()}|${commit}|${profile.profile}`
      const cached = cache.get(key)
      if (cached) {
        builds.push(cached)
        continue
      }

      let artifact: IRebuiltArtifact
      try {
        artifact = deps.build({
          contractName: record.contractName,
          commit,
          profile,
        })
      } catch (error) {
        return {
          kind: 'error',
          stage: 'rebuild-failed',
          reason: `${address} on ${network}: rebuilding ${
            record.contractName
          }@${record.version} at ${commit.slice(0, 9)} under profile ${
            profile.profile
          } failed, so there is no attested build to compare against — ${message(
            error
          )}`,
        }
      }

      const attestation = attestationFrom(record, commit, profile, artifact)
      if (!attestation.ok)
        return {
          kind: 'error',
          stage: 'artifact-unusable',
          reason: `${address} on ${network}: the rebuild of ${
            record.contractName
          } at ${commit.slice(0, 9)} under profile ${
            profile.profile
          } produced bytecode that cannot be normalised — ${
            attestation.reason
          }`,
        }

      cache.set(key, attestation.build)
      builds.push(attestation.build)
    }

    return { kind: 'built', builds, commitFetched: availability.fetched }
  }

  return {
    resolve,
    attestationsFor: async (
      address: string,
      network: string
    ): Promise<IAttestedBuild[]> => {
      const resolution = await resolve(address, network)
      if (resolution.kind === 'built') return resolution.builds
      if (resolution.kind === 'unattestable') return []
      throw new AttestationSourceError(resolution.stage, resolution.reason)
    },
  }
}

/**
 * @param error - whatever was thrown
 */
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
