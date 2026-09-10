/**
 * The key an attestation is filed and looked up under, and the audit bridge.
 *
 * Import this to file a mint or to look one up. The key names the source
 * closure, the settings and the toolchain, because anything it leaves out lets
 * two different builds share one entry — and the set-membership compare in
 * `attested-set.ts` is then answering about a build the deployed code is not.
 */

import { keccak256, stringToHex } from 'viem'

import { digestFault, normalizeHash } from './hex'

/** Which repo produced a build; the minter runs in both. */
export type BuildRepo = 'contracts' | 'contracts-tron'

/**
 * Where a build's settings were read from.
 *
 * In the key because a zk build's settings come from repo config rather than
 * the artifact, and a configured claim must not answer a lookup about a
 * self-reported build.
 */
export type SettingsSource = 'artifact' | 'config'

/** What a build is identified by. Everything here can change the bytecode. */
export interface IAttestationKey {
  /** Contract name as the artifact records it. */
  contractName: string
  /**
   * Source unit the contract was compiled from, e.g. `src/Facets/A.sol`. Two
   * contracts can share a closure — `LiFiDEXAggregator.sol` declares `IPool`
   * beside the aggregator — so the closure hash alone does not identify one.
   */
  sourceId: string
  /** Version the contract declares, e.g. `1.2.0`. */
  version: string
  /**
   * {@link sourceClosureHash} over every source the build compiled.
   *
   * In the key because a contract's own file and its declared version do not
   * move when something it inherits does, so neither identifies the bytecode a
   * shared helper produced.
   */
  closureHash: string
  /**
   * {@link artifactSettingsHash} or {@link configuredSettingsHash} over the
   * settings, depending on which of the two reported them.
   */
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
 * Length-prefixed rather than delimited, because a delimiter assumes no field
 * can contain it and source paths are outside this module's control.
 * @param fields - The fields, in the order the caller fixed
 * @returns A string only this field list can produce
 */
const joinFields = (fields: readonly string[]): string =>
  fields.map((field) => `${field.length}:${field}`).join('')

/**
 * Fields of `metadata.settings` that name the source rather than the settings.
 *
 * `compilationTarget` is carried as {@link IAttestationKey.sourceId}, and
 * `remappings` only decide what an import resolves to — the resolved sources
 * are named by {@link IAttestationKey.closureHash}, so hashing the remappings
 * too would split the key for a build whose bytecode did not move.
 */
const NOT_SETTINGS = ['compilationTarget', 'remappings']

/**
 * Deterministic JSON: object keys sorted at every depth, `null` dropped.
 *
 * Emitter key order is not part of the content, and a reader that fills absent
 * keys with `null` has to agree with one that omits them, or one build lands
 * under two keys.
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
  return JSON.stringify(value) ?? 'null'
}

/** The settings a hash is taken over: everything {@link NOT_SETTINGS} keeps. */
const hashableSettings = (
  settings: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(settings).filter(([key]) => !NOT_SETTINGS.includes(key))
  )

/**
 * Hashes settings under a tag saying where they came from.
 *
 * Not exported: the tag has to follow from what was read, so the only ways in
 * are {@link artifactSettingsHash} and {@link configuredSettingsHash}. A caller
 * free to pick the tag could mint an `artifact` hash from configured values,
 * which is the one thing the tag exists to prevent.
 */
const settingsHashTagged = (
  source: SettingsSource,
  settings: Record<string, unknown>
): string => {
  const hashable = hashableSettings(settings)
  if (Object.keys(hashable).length === 0)
    throw new Error('build settings are empty, so they identify no build')

  return keccak256(stringToHex(joinFields([source, canonicalJson(hashable)])))
}

/**
 * One hash over every setting a build reported for itself.
 *
 * Hashed whole rather than field by field, apart from {@link NOT_SETTINGS}: a
 * field list has to be kept complete against every compiler release, and an
 * incomplete one is silent — the omitted setting moves the bytecode, the key
 * does not, and two builds share an entry. Nothing is defaulted either, since
 * a supplied default files the build under a key naming a setting it may not
 * have used.
 * @param settings - `metadata.settings` from the contract's own artifact
 * @returns `0x`-prefixed keccak over the canonical settings
 * @throws When no setting survives {@link NOT_SETTINGS}
 */
export const artifactSettingsHash = (
  settings: Record<string, unknown>
): string => settingsHashTagged('artifact', settings)

/**
 * Settings hash for a build whose toolchain reports none.
 *
 * zksolc writes no `metadata` object, so a zk build's settings come from repo
 * configuration. Callers must agree on the shape they pass — the tag records
 * that the settings were claimed, not that two claimants spelled them alike.
 *
 * The same absence leaves a zk build with no source for
 * {@link IAttestationKey.closureHash}, which {@link sourceClosureHash} takes
 * from `metadata.sources`. A zk producer has to obtain that closure some other
 * way; there is no reader for it here.
 * @param settings - The configured settings, e.g. read from `foundry.toml`
 * @returns `0x`-prefixed keccak over the canonical settings, tagged `config`
 * @throws When no setting survives {@link NOT_SETTINGS}
 */
export const configuredSettingsHash = (
  settings: Record<string, unknown>
): string => settingsHashTagged('config', settings)

/** What a solc artifact reports about the build that produced it. */
export interface IArtifactIdentity {
  sourceId: string
  settingsHash: string
  settingsSource: SettingsSource
  /** The settings the hash was taken over, for a refusal a person must read. */
  hashedSettings: Record<string, unknown>
}

/**
 * Reads a build's source identity and settings hash out of its artifact.
 *
 * One reader rather than one per producer, so the mint in CI and a local
 * rebuild cannot disagree about the strip list or the canonical form.
 * @param settings - `metadata.settings` from the contract's own artifact
 * @returns Source id, settings hash, its tag, and the settings hashed
 * @throws When the artifact does not name exactly one compilation target, or
 * no setting survives {@link NOT_SETTINGS}
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
    settingsHash: artifactSettingsHash(settings),
    settingsSource: 'artifact',
    hashedSettings: hashableSettings(settings),
  }
}

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
 * @throws When a field is empty, or either hash is not a keccak digest
 */
export const serialiseAttestationKey = (key: IAttestationKey): string => {
  // Length-prefixing keeps an empty field collision-free, but a key naming no
  // contract also strips every refusal in this module of the name it reports.
  for (const [field, value] of [
    ['contract name', key.contractName],
    ['source id', key.sourceId],
    ['version', key.version],
    ['solc version', key.solcVersion],
  ] as const)
    if (value === '') throw new Error(`attestation key states no ${field}`)

  const fault =
    digestFault(key.closureHash, 'source closure hash') ??
    digestFault(key.settingsHash, 'settings hash')
  if (fault !== undefined)
    throw new Error(`${fault} in the key for ${key.contractName}`)

  return joinFields([
    key.contractName,
    key.sourceId,
    key.version,
    canonicalHash(key.closureHash),
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
}

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
 * Independent of every compiler setting, so the same sources built under
 * different settings bridge to the same audit record — an audit is of source,
 * not of a build. Paths are sorted so the hash does not depend on the order
 * solc emitted them.
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
    // Whichever of two hashes for one path is dropped, the resulting hash
    // claims a closure that was never compiled.
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
   * What the key hashes but does not spell out, so a refusal names the settings
   * rather than only their digest.
   */
  build: {
    /**
     * Not in the key: one source path exists in both repos with different
     * content, so the closure hash already separates those builds.
     */
    repo: BuildRepo
    /**
     * Not in the key: `[profile.ci]` inherits `[profile.default]` and differs
     * only in fuzz settings, so the two compile to the same bytes.
     */
    profile: string
    /** The settings the key's `settingsHash` was taken over. */
    hashedSettings: Record<string, unknown>
  }
  /** keccak of the runtime code after trailer-stripping and immutable masking. */
  maskedHash: string
}

/** Two attestations filed under one key that do not agree. */
export interface IAttestationConflict {
  /** The build the conflicting attestations claim to identify. */
  key: IAttestationKey
  /** Canonical form the attestations were grouped under. */
  serialisedKey: string
  /** The first attestation's provenance, so the refusal is legible. */
  build: IMintedAttestation['build']
  /** Every distinct masked hash filed under that key, in the order found. */
  maskedHashes: string[]
}

/**
 * Finds keys that more than one build has claimed with different bytecode.
 *
 * A caller must refuse on a non-empty result rather than choose. Two
 * attestations under one key mean the key does not identify the build, and a
 * lookup would then return whichever was filed first — so a gate consuming it
 * would vouch for bytecode on the strength of an attestation of something else.
 *
 * Agreeing duplicates are not conflicts: the same build attested twice, by CI
 * and locally, is the expected state.
 * @param attestations - Everything filed, in any order
 * @returns One entry per conflicting key; empty when every key agrees
 * @throws When an attestation's key is unserialisable, its masked hash is not a
 * keccak digest, or its provenance holds a value `structuredClone` refuses
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
    }
  >()
  for (const attestation of attestations) {
    const fault = digestFault(attestation.maskedHash, 'masked hash')
    if (fault !== undefined)
      throw new Error(
        `${fault} in the attestation for ${attestation.key.contractName}`
      )

    const serialised = serialiseAttestationKey(attestation.key)
    const entry = byKey.get(serialised) ?? {
      // Cloned rather than spread: a caller may annotate the refusal, and the
      // nested settings object would otherwise still be the caller's.
      key: structuredClone(attestation.key),
      build: structuredClone(attestation.build),
      masked: new Set<string>(),
    }
    entry.masked.add(canonicalHash(attestation.maskedHash))
    byKey.set(serialised, entry)
  }

  const conflicts: IAttestationConflict[] = []
  for (const [serialisedKey, entry] of byKey)
    if (entry.masked.size > 1)
      conflicts.push({
        key: entry.key,
        serialisedKey,
        build: entry.build,
        maskedHashes: [...entry.masked],
      })

  return conflicts
}
