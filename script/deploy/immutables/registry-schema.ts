/**
 * Validates the per-immutable registry in `immutableRegistry.json`.
 *
 * It has its own file so `protectSecurityRelevantCode.yml` can require InfoSec
 * approval for exactly it; folding it into `deployRequirements.json` would put
 * every routine deploy-requirement edit behind that approval too.
 *
 * Import this from the CI gate. It separates two things the gate must not
 * conflate: an immutable nobody has documented yet is a warning, because the
 * authoring pass is still running, while a registry that asserts something false
 * is an error whatever the mode.
 */

import type { IDeployRequirementEntry } from '../shared/immutableBindings'

import type { IImmutableDeclaration } from './immutable-declarations'

/**
 * How an immutable's expected value is established.
 *
 * `config` names a `configData` label rather than repeating its path, so the
 * deploy requirement and the expectation cannot drift apart. The link is
 * explicit because nothing derives it: a label, its constructor parameter and
 * the immutable it lands in are three independent spellings.
 */
export type ImmutableSource =
  | 'config'
  | 'derived'
  | 'unchecked'
  | 'unverifiable'

export interface IImmutableEntry {
  source?: unknown
  /** For `config`: the `configData` key under the same contract. */
  configData?: unknown
  /** For `derived`: how the value is computed. */
  rule?: unknown
  /** For `unchecked` and `unverifiable`: why, in a sentence. */
  reason?: unknown
  /** Flags an immutable that carries authority, for the drift report. */
  authorityBearing?: unknown
}

/**
 * A `deployRequirements.json` entry as this gate reads it: #2213's shape plus the
 * registry section. It extends `IDeployRequirementEntry` so the two gates cannot
 * drift on what that file's entries hold, even though this validator reads only
 * `configData` of them.
 */
export interface IContractRequirements extends IDeployRequirementEntry {
  immutables?: Record<string, IImmutableEntry>
}

export type DeployRequirements = Record<string, IContractRequirements>

export interface IRegistryValidation {
  /** The registry asserts something false. Blocks regardless of mode. */
  errors: string[]
  /** An immutable nobody has documented yet. The authoring pass closes these. */
  warnings: string[]
  /** `Contract.immutable` for every entry flagged authority-bearing. */
  authorityBearing: string[]
}

const KNOWN_SOURCES: readonly ImmutableSource[] = [
  'config',
  'derived',
  'unchecked',
  'unverifiable',
]

const contractOf = (file: string): string =>
  file
    .split('/')
    .pop()
    ?.replace(/\.sol$/u, '') ?? file

const nonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim() !== ''

const plainObject = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Checks the registry file's own shape before anything reads it.
 *
 * A section that is not an object of entries reads to the validator as a
 * contract with no entries, which is indistinguishable from one nobody has
 * authored yet. A truncated or half-edited registry would therefore report its
 * immutables as an authoring gap — warnings today, and nothing at all once
 * `--strict` makes the authored set the thing being enforced.
 *
 * @param registry - The parsed registry file.
 * @returns One error per malformed section or entry.
 */
export const validateRegistryShape = (registry: unknown): string[] => {
  if (!plainObject(registry))
    return ['The registry must be a JSON object keyed by contract name.']

  return Object.entries(registry as Record<string, unknown>).flatMap(
    ([contract, section]) => {
      if (!plainObject(section))
        return [
          `${contract} is not an object of immutable entries, so none of its entries can be read.`,
        ]

      return Object.entries(section as Record<string, unknown>)
        .filter(([, entry]) => !plainObject(entry))
        .map(
          (nameAndEntry) =>
            `${contract}.${nameAndEntry[0]} is not an object, so its source cannot be read.`
        )
    }
  )
}

/**
 * Checks the registry against what `src/` actually declares.
 *
 * @param declarations - Every immutable found in `src/`.
 * @param requirements - The parsed `deployRequirements.json`.
 * @returns Errors, warnings, and the authority-bearing entries.
 */
export const validateImmutableRegistry = (
  declarations: readonly IImmutableDeclaration[],
  requirements: DeployRequirements
): IRegistryValidation => {
  const errors: string[] = []
  const warnings: string[] = []
  const authorityBearing: string[] = []

  const declaredByContract = new Map<string, Set<string>>()
  for (const declaration of declarations) {
    const contract = contractOf(declaration.file)
    const names = declaredByContract.get(contract) ?? new Set<string>()
    names.add(declaration.name)
    declaredByContract.set(contract, names)
  }

  for (const declaration of declarations) {
    const contract = contractOf(declaration.file)
    const entry = requirements[contract]?.immutables?.[declaration.name]
    if (!entry)
      warnings.push(
        `${contract}.${declaration.name} has no registry entry (${declaration.file}:${declaration.line}). Declare it as config, derived, unchecked or unverifiable.`
      )
  }

  for (const [contract, contractRequirements] of Object.entries(requirements)) {
    const entries = contractRequirements.immutables
    if (!entries) continue
    const declaredHere = declaredByContract.get(contract) ?? new Set<string>()

    for (const [name, entry] of Object.entries(entries)) {
      const where = `${contract}.${name}`

      if (!declaredHere.has(name)) {
        errors.push(
          `${where} has a registry entry but ${contract} does not declare that immutable. A rename leaves an expectation nothing checks.`
        )
        continue
      }

      // A JSON `"true"` is not true. Silently dropping it would leave an
      // authority-bearing immutable unflagged in the drift report.
      if (entry.authorityBearing !== undefined) {
        if (typeof entry.authorityBearing !== 'boolean') {
          errors.push(
            `${where} has authorityBearing '${String(
              entry.authorityBearing
            )}', which is not a boolean. A quoted value would be read as unflagged.`
          )
          continue
        }
        if (entry.authorityBearing) authorityBearing.push(where)
      }

      const source = entry.source
      if (!KNOWN_SOURCES.includes(source as ImmutableSource)) {
        errors.push(
          `${where} has source '${String(
            source
          )}', which is not one of ${KNOWN_SOURCES.join(
            ', '
          )}. An unrecognised source would make it silently exempt.`
        )
        continue
      }

      if (source === 'config') {
        const label = entry.configData
        if (!nonEmptyString(label)) {
          errors.push(`${where} is config-sourced but names no configData key.`)
          continue
        }
        // `in` walks the prototype, so a label of 'toString' would pass against
        // any object at all and the link would read as valid.
        if (
          !Object.prototype.hasOwnProperty.call(
            contractRequirements.configData ?? {},
            label as string
          )
        )
          errors.push(
            `${where} points at configData key '${String(
              label
            )}', which ${contract} does not have.`
          )
      }

      if (source === 'derived' && !nonEmptyString(entry.rule))
        errors.push(`${where} is derived but gives no rule for the value.`)

      if (
        (source === 'unchecked' || source === 'unverifiable') &&
        !nonEmptyString(entry.reason)
      )
        errors.push(
          `${where} is ${source} but gives no reason. An exemption without one cannot be reviewed.`
        )
    }
  }

  return { errors, warnings, authorityBearing }
}
