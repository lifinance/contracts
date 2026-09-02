/**
 * Suggests which `deployRequirements.json` entry governs which immutable.
 *
 * Import this to BOOTSTRAP the registry's authoring pass, not to gate on it. The
 * match is a name heuristic and cannot be more than that: a `configData` key is
 * a free-form label, not a constructor parameter. `helperFunctions.sh` only ever
 * reads `configData | keys[]` to iterate and then follows
 * `configFileName`/`keyInConfigFile`, so nothing constrains the key's spelling.
 * `AcrossFacet` is the worked example: its constructor takes `_wrappedNative`,
 * it stores `wrappedNative`, and the registry files the requirement under
 * `_wrappedNativeAddress` — three spellings, one binding.
 *
 * A gate built on this heuristic would report 48 orphaned entries on today's
 * repo, almost all of them label drift rather than a missing expectation. That is
 * how a check becomes noise. The registry therefore needs each entry to name the
 * immutable it governs explicitly, and this module's job is to propose those
 * links for a human to confirm.
 */

import type { IImmutableDeclaration } from './immutable-declarations'

/** Contract name to the `configData` keys filed under it. */
export type RegistryEntries = Record<string, readonly string[]>

export interface IOrphanedEntry {
  contract: string
  entry: string
}

export interface IRegistryCoverage {
  /** Declarations whose name matches an entry under the same contract. */
  covered: IImmutableDeclaration[]
  /** Declarations no entry name resembles. */
  undeclared: IImmutableDeclaration[]
  /**
   * Entries no declaration name resembles. On today's repo this is dominated by
   * label drift, so treat it as "needs a human to link", never as "the
   * expectation is gone".
   */
  orphanedEntries: IOrphanedEntry[]
}

/**
 * Reduces a name to what the two sides have in common.
 *
 * `_spokePool` and `SPOKE_POOL` are the same binding written in two
 * conventions, so the comparison has to drop case, underscores and the
 * parameter's leading underscore. It cannot drop more than that: two names that
 * differ in any character still differ afterwards.
 *
 * @param name - A constructor parameter or an immutable's name.
 * @returns The comparable form.
 */
export const normaliseBindingName = (name: string): string =>
  name.replace(/_/gu, '').toLowerCase()

/** Contract name as `deployRequirements.json` keys it: the file's basename. */
const contractOf = (file: string): string =>
  file
    .split('/')
    .pop()
    ?.replace(/\.sol$/u, '') ?? file

/**
 * Proposes links in both directions.
 *
 * @param declarations - Every immutable found in `src/`.
 * @param entries - Contract name to its `configData` keys.
 * @returns Likely matches, unmatched declarations, and unmatched entries. None
 * of the three is a verdict; they are the input to the authoring pass.
 */
export const assessRegistryCoverage = (
  declarations: readonly IImmutableDeclaration[],
  entries: RegistryEntries
): IRegistryCoverage => {
  const covered: IImmutableDeclaration[] = []
  const undeclared: IImmutableDeclaration[] = []
  /** Per contract, the normalised entry names still unmatched. */
  const unmatched = new Map<string, Set<string>>(
    Object.entries(entries).map(([contract, keys]) => [
      contract,
      new Set(keys.map(normaliseBindingName)),
    ])
  )
  /** Normalised form back to what the registry actually wrote, for messages. */
  const original = new Map<string, Map<string, string>>(
    Object.entries(entries).map(([contract, keys]) => [
      contract,
      new Map(keys.map((key) => [normaliseBindingName(key), key])),
    ])
  )

  for (const declaration of declarations) {
    const contract = contractOf(declaration.file)
    const wanted = normaliseBindingName(declaration.name)
    const pool = unmatched.get(contract)

    if (pool?.has(wanted)) {
      pool.delete(wanted)
      covered.push(declaration)
    } else undeclared.push(declaration)
  }

  const orphanedEntries: IOrphanedEntry[] = []
  for (const [contract, leftover] of unmatched)
    for (const normalised of leftover)
      orphanedEntries.push({
        contract,
        entry: original.get(contract)?.get(normalised) ?? normalised,
      })

  return { covered, undeclared, orphanedEntries }
}
