/**
 * The key an attestation is filed and looked up under, and the audit bridge.
 *
 * A minted attestation says "this repo built this bytecode from this source
 * with this toolchain". The gate consumes it by looking the key up, so the key
 * has to name every input that can change the bytecode. Anything it leaves out
 * lets two different builds share one key, and then the set-membership compare
 * in `attested-set.ts` is answering about a build the deployed code is not.
 *
 * Two properties the fleet sweep made non-negotiable:
 *
 * - **`viaIR` and the zk toolchain belong in the key.** The solc fork and LLVM
 *   version float independently of `zkSolcVersion`, so a zk build is not
 *   identified by its zksolc version alone (F14).
 * - **The audit bridge is profile-independent.** `sourceClosureHash` is taken
 *   over the source closure only, never the settings, so the same sources
 *   compiled under two profiles bridge to the same audit (E1).
 */

import { keccak256, stringToHex } from 'viem'

/** A toolchain and settings combination a build can be produced under. */
export interface IAttestationKey {
  /** Contract name as the artifact records it. */
  contractName: string
  /** Version the contract declares, e.g. `1.2.0`. */
  version: string
  /** Foundry profile the build ran under. */
  profile: string
  /**
   * Whether the build went through the IR pipeline. Required rather than
   * optional: absent and `false` are the same build only by coincidence, and a
   * key that omits it silently merges an IR build with a legacy one.
   */
  viaIR: boolean
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
 * Stands in for an absent zk section.
 *
 * Named rather than empty so an EVM key cannot collide with a zk key whose
 * three versions happen to serialise to nothing.
 */
const NO_ZK = 'evm'

/**
 * Canonical string form of a key, for filing and comparison.
 *
 * Field order is fixed here and nowhere else, so two callers cannot disagree
 * about it. Every field is always present in the output — an absent zk section
 * is written as a marker rather than skipped — because a key that shortens when
 * a field is missing is a key two different builds can share.
 * @param key - The toolchain and settings the build ran under
 * @returns The canonical key string
 */
export const serialiseAttestationKey = (key: IAttestationKey): string =>
  joinFields([
    key.contractName,
    key.version,
    key.profile,
    key.viaIR ? 'viaIR' : 'legacy',
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
 * under a different profile, EVM version or pipeline bridge to the same audit
 * record. That is what makes it usable as an audit key at all — an audit is of
 * source, not of a build.
 *
 * Paths are sorted, so the hash does not depend on the order solc happened to
 * emit them. Each entry is length-prefixed so a path cannot impersonate the
 * start of the next field.
 * @param sources - Every source in the closure, in any order
 * @returns `0x`-prefixed keccak over the canonical closure
 * @throws When two entries claim the same path with different hashes
 */
export const sourceClosureHash = (sources: readonly ISourceEntry[]): string => {
  const byPath = new Map<string, string>()
  for (const entry of sources) {
    const keccak = entry.keccak.toLowerCase()
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
  /** keccak of the runtime code after trailer-stripping and immutable masking. */
  maskedHash: string
  /** The audit bridge for the sources this build compiled. */
  sourceClosureHash: string
}

/** Two attestations filed under one key that do not agree. */
export interface IAttestationConflict {
  key: string
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
 */
export const findAttestationConflicts = (
  attestations: readonly IMintedAttestation[]
): IAttestationConflict[] => {
  const byKey = new Map<string, { masked: string[]; closure: string[] }>()
  for (const attestation of attestations) {
    const serialised = serialiseAttestationKey(attestation.key)
    const entry = byKey.get(serialised) ?? { masked: [], closure: [] }
    const masked = attestation.maskedHash.toLowerCase()
    const closure = attestation.sourceClosureHash.toLowerCase()
    if (!entry.masked.includes(masked)) entry.masked.push(masked)
    if (!entry.closure.includes(closure)) entry.closure.push(closure)
    byKey.set(serialised, entry)
  }

  const conflicts: IAttestationConflict[] = []
  // Either disagreement is disqualifying on its own: the same bytecode from
  // two different source closures is as unusable as two bytecodes from one.
  for (const [key, entry] of byKey)
    if (entry.masked.length > 1 || entry.closure.length > 1)
      conflicts.push({
        key,
        maskedHashes: entry.masked,
        sourceClosureHashes: entry.closure,
      })

  return conflicts
}
