/**
 * The manifest CI mints and attests: what this repo built, per build, as bytes
 * a later run can look up without compiling.
 *
 * Import this to produce the manifest or to read one. It exists because the
 * attestation cannot hold it. A build-provenance attestation signs a filename
 * and a sha256 and nothing else, and GitHub indexes attestations by artifact
 * digest only — there is no lookup by contract, version or profile. So the
 * signed thing has to be a file that is itself keyed, and the attestation says
 * only that CI produced exactly these bytes.
 *
 * Two properties follow, and both are load-bearing:
 *
 * **The serialised form must be byte-stable.** The attestation binds a digest,
 * so a regeneration that differs by a space is a manifest the attestation no
 * longer covers. Entries are therefore ordered by their own key rather than by
 * the order a build runner happened to emit them.
 *
 * **A profile nobody minted is not an empty attested set.** Code built under a
 * toolchain outside {@link IBuildManifest.coveredProfiles} has not been checked
 * and found wanting; it has not been checked. Collapsing the two would grade an
 * honest zkEVM deploy as a mismatch on the strength of a manifest that never
 * claimed to describe it, so the covered profiles are recorded and a reader
 * that ignores them is reading the manifest wrong.
 */

import {
  findAttestationConflicts,
  serialiseAttestationKey,
  type BuildRepo,
  type IAttestationKey,
  type IMintedAttestation,
} from './attestation-key'
import { readMetadataTrailer } from './bytecode-trailer'
import type {
  IImmutableOccurrence,
  ImmutableReferences,
} from './immutable-offsets'
import { normalizeRuntimeCode } from './rebuild-attestations'

/** Schema version, so a reader can refuse a manifest it does not understand. */
export const MANIFEST_SCHEMA = 1

/** What a build contributes beyond its key: the fields a comparison needs. */
export interface IManifestEntry extends IMintedAttestation {
  /** Human label for the toolchain, as a signer will read it in a verdict. */
  lineage: string
  /** Length of the runtime code as built, before stripping or masking. */
  rawByteLength: number
  /**
   * keccak of the exact runtime bytes, present only where the comparison pins
   * them. On zkEVM the solc-fork/LLVM version lives in the trailer alone, so
   * stripping it is exactly what makes fork drift invisible; elsewhere the
   * trailer holds a source digest that moves for a changed comment.
   */
  rawHash?: string
  /**
   * Every immutable occurrence, ordered by offset; absent for a contract with
   * none.
   *
   * Carried because the reader has to mask the *deployed* code the same way to
   * compare it, and those offsets are the only place that says which bytes to
   * exclude. Without them a lookup could verify the manifest and still be
   * unable to use it.
   *
   * Flattened out of Foundry's AST-id-keyed map on purpose. An AST id counts
   * source units in the order solc loaded them, so the same contract compiled
   * in a different scope carries different ids for identical bytes — two
   * machines then serialise two manifests and the attested digest does not
   * survive a rebuild. Masking reads only the offsets, so the id is a key the
   * manifest can afford to drop and cannot afford to keep.
   */
  immutableOffsets?: IImmutableOccurrence[]
}

export interface IBuildManifest {
  schema: number
  /**
   * Every toolchain this manifest was minted under.
   *
   * A reader must treat code built outside this list as unverifiable rather
   * than unattested — see the module header.
   */
  coveredProfiles: string[]
  entries: IManifestEntry[]
}

/** What the mint knows about one contract before its bytecode is read. */
export interface IContractIdentity {
  contractName: string
  version: string
  repo: BuildRepo
}

/** One compile's output as the mint read it out of `out/`. */
export interface IBuiltArtifact {
  /** Runtime bytecode with its metadata trailer intact, `0x`-prefixed. */
  runtimeHex: string
  immutableReferences?: ImmutableReferences
}

/** The profile a build was produced under, as `foundry.toml` names it. */
export interface IMintProfile {
  profile: string
  /** Pinned solc, used only when the build's own trailer reports none. */
  solcVersion: string
  evmVersion: string
  /** Present exactly for a zkEVM profile. */
  zksolcVersion?: string
}

export interface IEntryRefused {
  ok: false
  reason: string
}

/**
 * Names a lineage the way a signer will read it in a verdict.
 *
 * States the toolchain only. Where a build ran is not something the mint can
 * observe — this same code produces the string on a laptop — so claiming it
 * here would put an unearned provenance in front of the one reader whose job
 * is to check provenance.
 * @param identity - the contract this build is of
 * @param profile - the compiler pair it was built under
 * @param solcVersion - the version the build's own trailer reported
 */
const describeLineage = (
  identity: IContractIdentity,
  profile: IMintProfile,
  solcVersion: string
): string => {
  const built = `${identity.contractName}@${identity.version}`
  if (profile.zksolcVersion === undefined)
    return `${built} (${profile.profile}: solc ${solcVersion}, ${profile.evmVersion})`

  return `${built} (${profile.profile}: zksolc ${profile.zksolcVersion}, solc ${solcVersion})`
}

/**
 * Rebuilds a value with every object's keys in sorted order.
 *
 * `settingsHash` is taken over a canonical form, so it does not move when solc
 * emits the same settings in a different order. Embedding the raw object would
 * let the manifest's bytes move under a hash that stayed put, which is the same
 * class of defect as keying immutables by AST id.
 * @param value - any JSON-shaped value
 * @returns The value with object keys ordered
 */
const canonicalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalise)
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([entryKey, entryValue]) => [entryKey, canonicalise(entryValue)])
    )
  return value
}

/**
 * Drops Foundry's AST-id grouping, keeping the occurrences in offset order.
 * @param refs - Foundry's `immutableReferences`
 * @returns Every occurrence, ordered by start offset
 */
const flattenOffsets = (refs: ImmutableReferences): IImmutableOccurrence[] =>
  Object.values(refs)
    .flat()
    .sort((a, b) => a.start - b.start)

/**
 * Turns one built artifact into a manifest entry.
 *
 * The solc version is read from the build's own trailer and falls back to the
 * profile's pin, since a build need not carry a trailer at all. That read is
 * safe here in a way that reading a *deployed* trailer never is: these bytes
 * are our own build output, not a proposer's.
 *
 * @param identity - the contract this build is of
 * @param key - everything that identifies the build, already assembled
 * @param profile - the compiler pair used
 * @param artifact - what the build produced
 * @param hashedSettings - the settings `key.settingsHash` was taken over
 * @returns The entry, or why the artifact is unusable
 */
export const manifestEntryFrom = (
  identity: IContractIdentity,
  key: IAttestationKey,
  profile: IMintProfile,
  artifact: IBuiltArtifact,
  hashedSettings: Record<string, unknown>
): { ok: true; entry: IManifestEntry } | IEntryRefused => {
  const isZk = profile.zksolcVersion !== undefined
  // The one normalisation both sides go through. A second "strip then mask"
  // here is how the mint and a local rebuild would come to disagree while both
  // look finished, and the comparison downstream is between exactly these two.
  const normalised = normalizeRuntimeCode(
    artifact.runtimeHex,
    artifact.immutableReferences,
    { isZk }
  )
  if (!normalised.ok) return { ok: false, reason: normalised.reason }

  const trailer = readMetadataTrailer(artifact.runtimeHex)
  const solcVersion =
    (trailer.present ? trailer.solcVersion : undefined) ?? profile.solcVersion

  return {
    ok: true,
    entry: {
      key,
      build: {
        repo: identity.repo,
        profile: profile.profile,
        hashedSettings: canonicalise(hashedSettings) as Record<string, unknown>,
      },
      maskedHash: normalised.maskedHash,
      lineage: describeLineage(identity, profile, solcVersion),
      rawByteLength: normalised.rawByteLength,
      ...(isZk ? { rawHash: normalised.rawHash } : {}),
      ...(artifact.immutableReferences === undefined
        ? {}
        : { immutableOffsets: flattenOffsets(artifact.immutableReferences) }),
    },
  }
}

/** Two builds filed under one key that do not agree about the bytecode. */
export class ManifestConflictError extends Error {
  public readonly keys: string[]

  /**
   * @param keys - the serialised keys more than one build claimed
   */
  public constructor(keys: string[]) {
    super(
      `${
        keys.length
      } attestation key(s) were claimed by builds with different bytecode, so the key does not identify the build: ${keys.join(
        ', '
      )}`
    )
    this.name = 'ManifestConflictError'
    this.keys = keys
  }
}

/**
 * Serialises a manifest to the exact bytes CI attests.
 *
 * Fails closed on conflicting entries rather than picking one: two builds under
 * one key mean the key does not identify the build, and a lookup would then
 * answer with whichever was written first — vouching for bytecode on the
 * strength of an attestation of something else.
 *
 * Entries are ordered by their own serialised key, so the bytes do not depend
 * on the order a build runner emitted them. Two runs of the same commit
 * therefore produce an identical digest, which is the only reason a committed
 * manifest and its attestation can stay bound.
 *
 * @param coveredProfiles - every profile this mint built, in any order
 * @param entries - the entries, in any order
 * @returns The manifest text, newline-terminated
 * @throws ManifestConflictError when one key carries disagreeing bytecode
 * @throws Error when no profile is named, or when an entry's key is
 * unserialisable or its masked hash is not a keccak digest
 */
export const serialiseManifest = (
  coveredProfiles: readonly string[],
  entries: readonly IManifestEntry[]
): string => {
  if (coveredProfiles.length === 0)
    throw new Error(
      'manifest names no covered profile, so a reader cannot tell an unminted toolchain from an unattested build'
    )

  const conflicts = findAttestationConflicts(entries)
  if (conflicts.length > 0)
    throw new ManifestConflictError(conflicts.map((c) => c.serialisedKey))

  const manifest: IBuildManifest = {
    schema: MANIFEST_SCHEMA,
    coveredProfiles: [...new Set(coveredProfiles)].sort(),
    entries: [...entries].sort((a, b) => {
      const left = serialiseAttestationKey(a.key)
      const right = serialiseAttestationKey(b.key)
      if (left !== right) return left < right ? -1 : 1
      // Two entries can share a key and still serialise differently: the
      // profile that produced them is deliberately outside the key. Ordering
      // them by the key alone would leave the bytes decided by the order the
      // runner emitted them, which is the one thing this file cannot afford.
      const leftEntry = JSON.stringify(a)
      const rightEntry = JSON.stringify(b)
      if (leftEntry === rightEntry) return 0
      return leftEntry < rightEntry ? -1 : 1
    }),
  }

  return `${JSON.stringify(manifest, null, 2)}\n`
}
