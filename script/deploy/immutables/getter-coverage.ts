/**
 * Coverage gate for the `immutable-bindings-match-config` health-check invariant.
 *
 * That invariant only checks constructor args annotated with a `getter` in
 * `script/deploy/resources/deployRequirements.json`, so a contract added without the
 * annotation reopens the bug class the invariant exists to close — a counterparty bound
 * immutably at construction, pointing at a migrated or dead address, invisible to presence
 * and owner checks. This module requires every public immutable address getter to be either
 * annotated or explicitly exempted.
 *
 * It reads {@link IImmutableDeclaration} from the compiler AST rather than parsing source, so
 * `visibility` and the declared type are the compiler's own answers: a `private` immutable
 * generates no getter, and an `enum` or a `uint256` cannot hold a counterparty. It shares that
 * enumeration — and the CI job that produces it — with the per-immutable registry gate, because
 * both are asking about the same set of immutables.
 */

import { readFileSync } from 'fs'

import type { IDeployRequirementEntry } from '../shared/immutableBindings'

import type { IImmutableDeclaration } from './immutable-ast'

/** Directories whose contracts are deployed and therefore worth gating. */
const GATED_SOURCE_DIRECTORIES = [
  'src/Facets/',
  'src/Periphery/',
  'src/Security/',
]

/**
 * Types that cannot hold an address, as the compiler names them.
 *
 * Solidity restricts `immutable` to value types, so anything else a declaration can name —
 * `address`, `address payable`, or a contract/interface type — is address-valued. Deciding it
 * this way is fail-closed: an unfamiliar type stays inside the gate and has to be annotated or
 * exempted deliberately, rather than being skipped on a guess.
 */
const NON_ADDRESS_TYPE = /^(?:u?int\d*|bool|bytes\d*|string|enum\s)/

/** A public immutable getter, keyed the way `deployRequirements.json` annotates it. */
export interface IDeclaredImmutableGetter {
  contractName: string
  getter: string
  solidityType: string
  /** Repo-relative path, so a failure message points at the file to fix. */
  sourceFile: string
}

/**
 * Public immutable address getters that `immutable-bindings-match-config` does not check, each
 * with the reason it is not checked. Keyed `<Contract>.<GETTER>`.
 *
 * Data rather than a TypeScript constant, so the gate stays a function of the repo it is run in
 * — a list compiled into the binary reads as entirely stale anywhere else, including this gate's
 * own tests. It sits beside the gate so the InfoSec protection on
 * `script/deploy/immutables/` already covers it: recording a binding as exempt is a decision
 * about what goes unverified, and needs the same approval as changing the checker.
 *
 * The gate fails on an entry with no reason, one that has since been annotated, and one whose
 * getter no longer exists, so the list cannot quietly accumulate and misrepresent how much of
 * the fleet is verified. Annotating the binding is always the preferred fix; add an entry here
 * only when no config file holds a value to compare against, or when the invariant cannot
 * express the expectation — in which case the reason names the blocking ticket, which review
 * enforces rather than the gate.
 */
export const EXEMPTIONS_PATH = 'script/deploy/immutables/getter-exemptions.json'

/**
 * Reads the recorded exemptions.
 *
 * An unreadable list defaults to no exemptions rather than throwing: every exempt getter then
 * reports as unaccounted, which is loud and fail-closed.
 *
 * @param path - repo-relative path; defaults to {@link EXEMPTIONS_PATH}.
 * @returns getter key to the reason it is not checked.
 */
export const readGetterExemptions = (
  path: string = EXEMPTIONS_PATH
): Record<string, string> => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * The public immutable address getters declared by every deployed contract.
 *
 * @remarks A public immutable's compiler-generated getter carries the variable's own name, so the
 *   name here is exactly the `getter` value a `deployRequirements.json` annotation needs.
 * @param declarations - every immutable in `src/`, from the AST enumeration.
 * @param directories - source roots to gate; defaults to the facet, periphery and security trees.
 * @returns one entry per getter, sorted by contract then getter for stable output.
 */
export const collectPublicImmutableGetters = (
  declarations: readonly IImmutableDeclaration[],
  directories: readonly string[] = GATED_SOURCE_DIRECTORIES
): IDeclaredImmutableGetter[] =>
  declarations
    .filter((declaration) => declaration.visibility === 'public')
    .filter((declaration) => !NON_ADDRESS_TYPE.test(declaration.type))
    .filter((declaration) =>
      directories.some((directory) => declaration.file.startsWith(directory))
    )
    .map((declaration) => ({
      contractName: declaration.contract,
      getter: declaration.name,
      solidityType: declaration.type,
      sourceFile: declaration.file,
    }))
    .sort((a, b) =>
      `${a.contractName}.${a.getter}`.localeCompare(
        `${b.contractName}.${b.getter}`
      )
    )

/**
 * The `<Contract>.<GETTER>` keys that `deployRequirements.json` already annotates.
 *
 * @remarks Read straight from the registry rather than through `collectImmutableBindingChecks`,
 *   so that a config file the annotation points at being unreadable cannot make an annotated
 *   binding look unannotated and shift the blame here.
 * @param deployRequirements - the parsed `deployRequirements.json`.
 * @returns the annotated keys.
 */
export const collectAnnotatedGetterKeys = (
  deployRequirements: Record<string, IDeployRequirementEntry>
): Set<string> => {
  const keys = new Set<string>()

  for (const [contractName, entry] of Object.entries(deployRequirements))
    for (const configData of Object.values(entry.configData ?? {}))
      if (configData.getter) keys.add(`${contractName}.${configData.getter}`)

  return keys
}

/**
 * Everything wrong with the current state of getter coverage.
 *
 * All four are errors rather than warnings: unlike the registry's authoring gap, none of them is
 * missing documentation. An unaccounted getter is an unverified binding, and each of the other
 * three is an exemption list that has stopped describing the code.
 *
 * @param declarations - every immutable in `src/`, from the AST enumeration.
 * @param exemptions - the recorded exemptions, from {@link readGetterExemptions}.
 * @param annotated - annotated keys, from {@link collectAnnotatedGetterKeys}.
 * @returns one message per problem, in a stable order.
 */
export const verifyGetterCoverage = (
  declarations: readonly IImmutableDeclaration[],
  exemptions: Record<string, string>,
  annotated: Set<string>
): string[] => {
  const declared = collectPublicImmutableGetters(declarations)
  const declaredKeys = new Set(
    declared.map((getter) => `${getter.contractName}.${getter.getter}`)
  )
  const exempt = new Set(Object.keys(exemptions))
  const errors: string[] = []

  for (const getter of declared) {
    const key = `${getter.contractName}.${getter.getter}`
    if (annotated.has(key) || exempt.has(key)) continue
    errors.push(
      `${key} (${getter.sourceFile}) is a public immutable address getter that nothing checks. Annotate the binding with a 'getter' in deployRequirements.json, or record why it cannot be checked.`
    )
  }

  for (const key of Object.keys(exemptions).sort()) {
    if (annotated.has(key))
      errors.push(
        `${key} is exempted but now annotated. Drop the exemption — an annotated binding is verified, so the reason no longer holds.`
      )
    else if (!declaredKeys.has(key))
      errors.push(
        `${key} is exempted but no contract declares it. A renamed or deleted getter must leave the list, or it hides how much is actually unverified.`
      )

    if ((exemptions[key] ?? '').trim().length === 0)
      errors.push(`${key} is exempted with no reason given.`)
  }

  return errors
}
