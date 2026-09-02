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

import {
  findUnreadableImmutableLines,
  parseImmutableDeclarations,
} from './immutable-declarations'
import {
  validateImmutableRegistry,
  validateRegistryShape,
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

  const files = execFileSync('git', ['ls-files', 'src/*.sol'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)

  const sources = files.map(
    (file) => [file, readFileSync(file, 'utf8')] as const
  )
  const declarations = sources.flatMap(([file, source]) =>
    parseImmutableDeclarations(source, file)
  )
  // Asked before anything else: an immutable the enumerator cannot read is never
  // asked for, so it would never appear as a missing entry.
  const unreadable = sources.flatMap(([file, source]) =>
    findUnreadableImmutableLines(source, file)
  )

  const registry = readJson<Registry>(REGISTRY_PATH)
  const shapeErrors = validateRegistryShape(registry)
  if (shapeErrors.length > 0) {
    for (const error of shapeErrors) consola.error(error)
    consola.error(
      `${REGISTRY_PATH} is malformed. Every entry it cannot read would otherwise report as an authoring gap.`
    )
    process.exit(1)
  }

  const { errors, warnings, authorityBearing } = validateImmutableRegistry(
    declarations,
    mergeRequirements(readJson<DeployRequirements>(REQUIREMENTS_PATH), registry)
  )

  consola.info(
    `${declarations.length} immutables declared in src/; ${
      declarations.length - warnings.length
    } carry a registry entry, ${
      authorityBearing.length
    } flagged authority-bearing`
  )

  for (const { file, line, text } of unreadable)
    consola.error(
      `${file}:${line} mentions immutable but could not be read as a declaration: ${text}. Teach the parser this shape, or write it as '<type> [visibility] immutable <NAME>;' — an immutable the gate cannot see is one the registry is never asked to account for.`
    )
  for (const error of errors) consola.error(error)
  for (const warning of warnings) consola.warn(warning)

  if (unreadable.length + errors.length > 0) {
    consola.error(
      `${errors.length} registry error(s) and ${unreadable.length} unreadable declaration(s). Neither is missing documentation, so both fail in either mode.`
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
