/**
 * The key an attestation is filed and looked up under, and the audit bridge.
 *
 * A minted attestation says "this repo built this bytecode from this source
 * with this toolchain". The gate consumes it by looking the key up, so the key
 * has to name every input that can change the bytecode. Anything it leaves out
 * lets two different builds share one key, and then the set-membership compare
 * in `attested-set.ts` is answering about a build the deployed code is not.
 *
 * Four properties the fleet sweep made non-negotiable:
 *
 * - **The settings are hashed whole, never enumerated.** A field list has to
 *   stay complete against every compiler release, and the failure of an
 *   incomplete one is silent and in the unsafe direction. `metadata.settings`
 *   is hashed as the compiler emitted it, so a setting nobody has heard of yet
 *   is covered the day it appears.
 * - **`solcVersion` and the zk toolchain are named separately.** They are not
 *   in `metadata.settings`, and the solc fork and LLVM version float
 *   independently of `zksolcVersion`, so a zk build is not identified by its
 *   zksolc version alone (F14).
 * - **A contract's name does not identify its source.** Two unrelated `IPool`
 *   contracts exist in `src/Periphery/`, and one contract name exists in both
 *   repos with different code, so `sourceId` and `repo` are part of the key.
 * - **The audit bridge is settings-independent.** `sourceClosureHash` is taken
 *   over the source closure only, so the same sources compiled under two
 *   settings bridge to the same audit (E1).
 */

import { keccak256, stringToHex } from 'viem'

import { digestFault, normalizeHash } from './hex'

/** Which repo produced a build; the minter runs in both. */
export type BuildRepo = 'contracts' | 'contracts-tron'

/**
 * Where a build's settings were read from.
 *
 * Part of the key rather than a note beside it. zksolc records no settings at
 * all, so a zk build's come from repo configuration — a claim about what we
 * asked for, not a report of what ran. A key that did not separate the two
 * would let a configured claim answer a lookup about a self-reported build.
 */
export type SettingsSource = 'artifact' | 'config'

/** What a build is identified by. Everything here can change the bytecode. */
export interface IAttestationKey {
  /** Contract name as the artifact records it. */
  contractName: string
  /**
   * Source unit the contract was compiled from, e.g. `src/Facets/A.sol`. Taken
   * from `metadata.settings.compilationTarget`, which is the only thing in the
   * artifact that distinguishes two contracts sharing a name.
   */
  sourceId: string
  /** Repo the build ran in; one source path exists in both with different code. */
  repo: BuildRepo
  /** Version the contract declares, e.g. `1.2.0`. */
  version: string
  /** {@link buildSettingsHash} over the settings the build ran under. */
  settingsHash: string
  /** Whether those settings were self-reported or configured. */
  settingsSource: SettingsSource
  /** solc version, read from the build's own trailer rather than a record. */
  solcVersion: string
  /**
   * The zk toolchain, present exactly for a zkEVM build. All three move
   * together because the fork and LLVM versions float independently of the
   * zksolc release, so naming only `zksolcVersion` does not identify the build.
   */
  zk?: {
    zksolcVersion: string
    /** The solc *fork* zksolc used, which is not the upstream solc version. */
    solcForkVersion: string
    llvmVersion: string
  }
}

/**
 * Joins fields so that no two different field lists can produce one string.
 *
 * Length-prefixed rather than delimited. A delimiter only works while no field
 * can contain it, which is an assumption about every present and future input —
 * and source paths in particular are outside this module's control. Prefixing
 * each field with its length needs no such assumption: the reader knows where
 * each field ends before it starts reading it, so `['A', 'B C']` and
 * `['A B', 'C']` cannot collide.
 * @param fields - The fields, in the order the caller fixed
 * @returns A string only this field list can produce
 */
const joinFields = (fields: readonly string[]): string =>
  fields.map((field) => `${field.length}:${field}`).join('')

/**
 * Fields of `metadata.settings` that describe the source, not the settings.
 *
 * `compilationTarget` is the source identity and is promoted to
 * {@link IAttestationKey.sourceId}. `remappings` decide which files an import
 * resolves to, not what the compiler does with the files it resolved — and the
 * resolved sources are already covered by {@link sourceClosureHash}, so hashing
 * remappings here would split the key for identical bytecode after a repo
 * reorganisation. Nothing else is stripped: the whole point of hashing rather
 * than enumerating is that this list stays short and justified.
 */
const NOT_SETTINGS = ['compilationTarget', 'remappings']

/**
 * Deterministic JSON: object keys sorted, absent values indistinguishable.
 *
 * Two normalisations, both load-bearing. Key order is whatever the emitter
 * happened to use, so sorting is what makes the hash a function of the content.
 * `null` values are dropped so a reader that fills absent keys with `null`
 * agrees with one that omits them — solc emits `viaIR` only when the pipeline
 * ran, and `{}` and `{viaIR: null}` are the same build.
 * @param value - Any JSON value
 * @returns The canonical text form of that value
 */
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return value === undefined ? 'null' : JSON.stringify(value)
}

/** Settings with the source-describing fields removed, ready to hash. */
const settingsForHashing = (
  settings: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(settings).filter(([key]) => !NOT_SETTINGS.includes(key))
  )

/**
 * One hash over every setting a build ran under.
 *
 * Hashed whole rather than enumerated field by field. A field list has to be
 * kept complete against every compiler release, and an incomplete one fails
 * silently in the unsafe direction: the omitted setting changes the bytecode,
 * the key does not change, and two builds share an entry. Hashing what the
 * compiler emitted has no such list — `optimizer.details`, `metadata.appendCBOR`
 * and anything a future release adds are all covered without being named.
 *
 * The cost is legibility, which is why {@link IMintedAttestation} carries the
 * readable settings beside the key for anything a person has to act on.
 * @param source - Whether the settings were self-reported or configured
 * @param settings - The settings, as the compiler or the config states them
 * @returns `0x`-prefixed keccak over the canonical settings
 * @throws When there are no settings to hash
 */
export const buildSettingsHash = (
  source: SettingsSource,
  settings: Record<string, unknown>
): string => {
  const hashable = settingsForHashing(settings)
  if (Object.keys(hashable).length === 0)
    throw new Error('build settings are empty, so they identify no build')

  return keccak256(stringToHex(joinFields([source, canonicalJson(hashable)])))
}

/** The part of a build a solc artifact reports about itself. */
export interface IArtifactIdentity {
  sourceId: string
  settingsHash: string
  settingsSource: SettingsSource
  /** The settings as emitted, for a refusal a person has to read. */
  settings: Record<string, unknown>
}

/**
 * Reads a build's source identity and settings hash out of its artifact.
 *
 * One reader rather than one per producer: the mint in CI and a local rebuild
 * have to agree on the strip list and the canonical form, and two producers
 * deciding those separately is the same bug twice.
 *
 * There is deliberately no defaulting. Every setting has a compiler default,
 * but supplying one here files the build under a key naming a setting the build
 * may not have used — and unlike a missing field, a wrong one is unfalsifiable
 * after the fact.
 * @param settings - `metadata.settings` from the contract's own artifact
 * @returns Source identity, settings hash, and the settings as emitted
 * @throws When the artifact names no compilation target or carries no settings
 */
export const identityFromArtifactMetadata = (
  settings: Record<string, unknown>
): IArtifactIdentity => {
  const target = settings['compilationTarget']
  const paths =
    typeof target === 'object' && target !== null ? Object.keys(target) : []
  if (paths.length !== 1)
    throw new Error(
      `build artifact names ${paths.length} compilation targets, so which source it compiled cannot be established`
    )

  return {
    sourceId: paths[0] as string,
    settingsHash: buildSettingsHash('artifact', settings),
    settingsSource: 'artifact',
    settings: settingsForHashing(settings),
  }
}

/**
 * Settings hash for a build whose toolchain reports none.
 *
 * zksolc writes no `metadata` object at all — verified across a full `zkout/`
 * tree — so a zk build's settings exist nowhere on disk and have to come from
 * repo configuration. That is a claim about what we asked the compiler for, not
 * a report of what it did, which is why the resulting key is tagged `config`
 * and can never answer a lookup for a self-reported build.
 * @param settings - The configured settings, e.g. from `foundry.toml`
 * @returns `0x`-prefixed keccak over the canonical settings, tagged `config`
 * @throws When there are no settings to hash
 */
export const configuredSettingsHash = (
  settings: Record<string, unknown>
): string => buildSettingsHash('config', settings)

/**
 * Stands in for an absent zk section.
 *
 * Named rather than empty so an EVM key cannot collide with a zk key whose
 * three versions happen to serialise to nothing.
 */
const NO_ZK = 'evm'

/** Hash as this module reports and compares it: `0x`-prefixed, lower case. */
const canonicalHash = (hash: string): string => `0x${normalizeHash(hash)}`

/**
 * Canonical string form of a key, for filing and comparison.
 *
 * Field order is fixed here and nowhere else, so two callers cannot disagree
 * about it. Every field is always present in the output — an absent zk section
 * is written as a marker rather than skipped — because a key that shortens when
 * a field is missing is a key two different builds can share.
 * @param key - What identifies the build
 * @returns The canonical key string
 */
export const serialiseAttestationKey = (key: IAttestationKey): string =>
  joinFields([
    key.contractName,
    key.sourceId,
    key.repo,
    key.version,
    canonicalHash(key.settingsHash),
    key.settingsSource,
    key.solcVersion,
    key.zk
      ? joinFields([
          'zk',
          key.zk.zksolcVersion,
          key.zk.solcForkVersion,
          key.zk.llvmVersion,
        ])
      : NO_ZK,
  ])

/**
 * One entry of solc's `metadata.sources`: a path and the source's own hash.
 *
 * solc records a keccak per source file, so the closure can be hashed without
 * re-reading the files — and without depending on line endings or on where the
 * checkout happens to live.
 */
export interface ISourceEntry {
  path: string
  /** The `keccak256` solc recorded for that source, `0x`-prefixed. */
  keccak: string
}

/**
 * The audit bridge: one hash over the source closure a build compiled.
 *
 * Deliberately independent of every compiler setting, so the same sources built
 * under different settings bridge to the same audit record. That is what makes
 * it usable as an audit key at all — an audit is of source, not of a build.
 *
 * Paths are sorted, so the hash does not depend on the order solc happened to
 * emit them. Fields are length-prefixed, so a path cannot impersonate the start
 * of the next field.
 * @param sources - Every source in the closure, in any order
 * @returns `0x`-prefixed keccak over the canonical closure
 * @throws When an entry names no path, its hash is not a keccak digest, or two
 * entries claim the same path with different hashes
 */
export const sourceClosureHash = (sources: readonly ISourceEntry[]): string => {
  const byPath = new Map<string, string>()
  for (const entry of sources) {
    if (entry.path === '')
      throw new Error('source closure carries an entry with no path')
    const fault = digestFault(entry.keccak, `source hash for ${entry.path}`)
    if (fault !== undefined) throw new Error(fault)

    const keccak = canonicalHash(entry.keccak)
    const seen = byPath.get(entry.path)
    // Two hashes for one path is not something to pick a winner from: whichever
    // is dropped, the resulting hash claims a closure that was never compiled.
    if (seen !== undefined && seen !== keccak)
      throw new Error(
        `source closure names ${entry.path} twice with different hashes, so which source was compiled cannot be established`
      )
    byPath.set(entry.path, keccak)
  }

  const canonical = joinFields(
    [...byPath.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([path, hash]) => [path, hash])
  )

  return keccak256(stringToHex(canonical))
}

/** What a mint records for one key. */
export interface IMintedAttestation {
  key: IAttestationKey
  /**
   * Provenance the key hashes but does not spell out. Carried so a refusal a
   * signer has to act on names the settings rather than only their digest, and
   * so the Foundry profile survives without being part of the identity — two
   * profiles that compile to the same bytes are one build.
   */
  build: {
    profile: string
    settings: Record<string, unknown>
  }
  /** keccak of the runtime code after trailer-stripping and immutable masking. */
  maskedHash: string
  /** The audit bridge for the sources this build compiled. */
  sourceClosureHash: string
}

/** Two attestations filed under one key that do not agree. */
export interface IAttestationConflict {
  /** The build the conflicting attestations claim to identify. */
  key: IAttestationKey
  /** Canonical form the attestations were grouped under. */
  serialisedKey: string
  /** The first attestation's readable settings, so the refusal is legible. */
  build: IMintedAttestation['build']
  /** Every distinct masked hash filed under that key, in the order found. */
  maskedHashes: string[]
  /** Every distinct source closure filed under it, in the order found. */
  sourceClosureHashes: string[]
}

/**
 * Finds keys that more than one build has claimed with different results.
 *
 * A caller must refuse on a non-empty result rather than choose. Two
 * attestations under one key mean the key does not identify the build, and a
 * lookup would then return whichever was filed first — so a gate consuming it
 * would vouch for bytecode on the strength of an attestation of something else.
 * That is the whole failure this returns rather than resolves.
 *
 * Agreeing duplicates are not conflicts: the same build attested twice, by CI
 * and locally, is the expected state.
 * @param attestations - Everything filed, in any order
 * @returns One entry per conflicting key; empty when every key agrees
 * @throws When an attestation carries a hash that is not a keccak digest
 */
export const findAttestationConflicts = (
  attestations: readonly IMintedAttestation[]
): IAttestationConflict[] => {
  const byKey = new Map<
    string,
    {
      key: IAttestationKey
      build: IMintedAttestation['build']
      masked: Set<string>
      closure: Set<string>
    }
  >()
  for (const attestation of attestations) {
    const fault =
      digestFault(attestation.maskedHash, 'masked hash') ??
      digestFault(attestation.sourceClosureHash, 'source closure hash')
    if (fault !== undefined)
      throw new Error(
        `${fault} in the attestation for ${attestation.key.contractName}`
      )

    const serialised = serialiseAttestationKey(attestation.key)
    const entry = byKey.get(serialised) ?? {
      // Copied: this is handed back inside a refusal a caller may keep or
      // annotate, and the attestations it came from are the caller's.
      key: { ...attestation.key },
      build: { ...attestation.build },
      masked: new Set<string>(),
      closure: new Set<string>(),
    }
    entry.masked.add(canonicalHash(attestation.maskedHash))
    entry.closure.add(canonicalHash(attestation.sourceClosureHash))
    byKey.set(serialised, entry)
  }

  const conflicts: IAttestationConflict[] = []
  // Either disagreement is disqualifying on its own: the same bytecode from
  // two different source closures is as unusable as two bytecodes from one.
  for (const [serialisedKey, entry] of byKey)
    if (entry.masked.size > 1 || entry.closure.size > 1)
      conflicts.push({
        key: entry.key,
        serialisedKey,
        build: entry.build,
        maskedHashes: [...entry.masked],
        sourceClosureHashes: [...entry.closure],
      })

  return conflicts
}
