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
  buildAst,
  findSourcesWithoutAst,
  readImmutableDeclarations,
} from './immutable-ast'
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
export const mergeRequirements = (
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

/** What the run reported, in the terms the exit code is decided on. */
export interface IVerificationCounts {
  /** Source files the compiler emitted no AST for, and so were never enumerated. */
  unenumerated: number
  /** Things the registry gets wrong. */
  errors: number
  /** Immutables with no registry entry yet. */
  warnings: number
}

/**
 * Decides the process exit code.
 *
 * Split out because the authoring gap is the only category `--strict` changes:
 * an unenumerated source file and a wrong entry are not missing documentation, so
 * they fail in either mode. Keeping that in the CLI body left the routing
 * reachable only by running the process.
 *
 * @param counts - What the run found.
 * @param strict - Whether `--strict` was passed.
 * @returns The exit code, and the reason to print when it is non-zero.
 */
export const decideExit = (
  counts: IVerificationCounts,
  strict: boolean
): { code: 0 | 1; reason: string | null } => {
  if (counts.unenumerated + counts.errors > 0)
    return {
      code: 1,
      reason: `${counts.errors} registry error(s) and ${counts.unenumerated} unenumerated source file(s). Neither is missing documentation, so both fail in either mode.`,
    }

  if (counts.warnings > 0 && strict)
    return {
      code: 1,
      reason: `${counts.warnings} immutable(s) have no registry entry, and --strict was passed.`,
    }

  return { code: 0, reason: null }
}

const main = (): void => {
  const strict = process.argv.includes('--strict')

  const files = execFileSync('git', ['ls-files', 'src/*.sol'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)

  const outDir = buildAst()
  const { declarations, sourceFiles } = readImmutableDeclarations(outDir)
  // Asked before anything else: an immutable in a file the compiler emitted no AST for is never
  // asked for, so it would never appear as a missing entry.
  const unenumerated = findSourcesWithoutAst(files, sourceFiles)

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

  for (const file of unenumerated)
    consola.error(
      `${file} is tracked under src/ but the compiler emitted no AST for it, so any immutable it declares was never enumerated. Check that it compiles and is not excluded from the build.`
    )
  for (const error of errors) consola.error(error)
  for (const warning of warnings) consola.warn(warning)

  const decision = decideExit(
    {
      unenumerated: unenumerated.length,
      errors: errors.length,
      warnings: warnings.length,
    },
    strict
  )
  if (decision.code === 1) {
    if (decision.reason) consola.error(decision.reason)
    process.exit(1)
  }

  if (warnings.length > 0)
    consola.warn(
      `${warnings.length} immutable(s) have no registry entry yet. Warn-only until the authoring pass completes; pass --strict to fail on these.`
    )
  else consola.success('every immutable in src/ has a registry entry')
}

if (import.meta.main) main()
