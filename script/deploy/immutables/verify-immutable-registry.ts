/**
 * CI entry point for the per-immutable registry.
 *
 * Run it from the repo root. It reads `src/`, the registry and the deploy
 * requirements, and reports what the registry gets wrong and what it has yet to
 * cover. Warn-only by default; `--strict` also fails on the authoring gap, which
 * is what flips on once the authoring pass is complete.
 */

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

import { consola } from 'consola'

import { parseImmutableDeclarations } from './immutable-declarations'
import {
  validateImmutableRegistry,
  type DeployRequirements,
  type IImmutableEntry,
} from './registry-schema'

const REGISTRY_PATH = 'script/deploy/resources/immutableRegistry.json'
const REQUIREMENTS_PATH = 'script/deploy/resources/deployRequirements.json'

/**
 * The registry lives in its own file so the InfoSec protection in
 * `protectSecurityRelevantCode.yml` can cover it exactly. Folding it into
 * `deployRequirements.json` would put every routine deploy-requirement edit
 * behind that approval, which is a cost nobody asked for.
 */
type Registry = Record<string, Record<string, IImmutableEntry>>

const readJson = <T>(path: string): T =>
  JSON.parse(readFileSync(path, 'utf8')) as T

/** Joins the two files into the view the validator checks. */
const mergeRequirements = (
  requirements: DeployRequirements,
  registry: Registry
): DeployRequirements => {
  const contracts = new Set([
    ...Object.keys(requirements),
    ...Object.keys(registry),
  ])
  return Object.fromEntries(
    [...contracts].map((contract) => [
      contract,
      {
        ...(requirements[contract]?.configData
          ? { configData: requirements[contract]?.configData }
          : {}),
        ...(registry[contract] ? { immutables: registry[contract] } : {}),
      },
    ])
  )
}

const main = (): void => {
  const strict = process.argv.includes('--strict')

  const files = execFileSync('git', ['ls-files', 'src/**/*.sol'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)

  const declarations = files.flatMap((file) =>
    parseImmutableDeclarations(readFileSync(file, 'utf8'), file)
  )

  const { errors, warnings, authorityBearing } = validateImmutableRegistry(
    declarations,
    mergeRequirements(
      readJson<DeployRequirements>(REQUIREMENTS_PATH),
      readJson<Registry>(REGISTRY_PATH)
    )
  )

  consola.info(
    `${declarations.length} immutables declared in src/; ${
      declarations.length - warnings.length
    } carry a registry entry, ${
      authorityBearing.length
    } flagged authority-bearing`
  )

  for (const error of errors) consola.error(error)
  for (const warning of warnings) consola.warn(warning)

  if (errors.length > 0) {
    consola.error(
      `${errors.length} registry error(s). These are assertions the registry gets wrong, not missing documentation, so they fail in either mode.`
    )
    process.exit(1)
  }

  if (warnings.length > 0 && strict) {
    consola.error(
      `${warnings.length} immutable(s) have no registry entry, and --strict was passed.`
    )
    process.exit(1)
  }

  if (warnings.length > 0)
    consola.warn(
      `${warnings.length} immutable(s) have no registry entry yet. Warn-only until the authoring pass completes; pass --strict to fail on these.`
    )
  else consola.success('every immutable in src/ has a registry entry')
}

main()
