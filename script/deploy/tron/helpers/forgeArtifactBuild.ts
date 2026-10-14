/**
 * Refuses a Forge artifact that the Tron deploy scripts would deploy under the wrong label:
 * one compiled from source that has since changed, or by a compiler or settings other than
 * the checkout's default profile. Called from the Tron deploy chokepoint in `../tronUtils.ts`.
 *
 * The scripts load `out/` without compiling and label each deployment with the source file's
 * `@custom:version`, so either kind of mismatch puts bytecode on chain that a rebuild of the
 * labelled version does not reproduce.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parse } from 'smol-toml'
import { keccak256 } from 'viem'

import { digestFault, normalizeHash } from '../../codehash/hex'

/**
 * Thrown when the artifact itself is the problem, so callers that add context about
 * constructor arguments can pass it through unchanged: the fix is a rebuild, not a code edit.
 */
export class ForgeArtifactBuildError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'ForgeArtifactBuildError'
  }
}

/** The settings of `[profile.default]` that change the bytecode solc emits. */
export interface IForgeBuildProfile {
  solcVersion: string
  evmVersion: string
  optimizer?: boolean
  optimizerRuns?: number
  viaIr: boolean
}

const REBUILD = 'Run `forge build` and retry.'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readMetadata = (artifact: {
  metadata?: unknown
}): Record<string, unknown> =>
  isRecord(artifact?.metadata) ? artifact.metadata : {}

/**
 * Reads the bytecode-relevant settings of the checkout's `[profile.default]`.
 *
 * Always the default profile, never `FOUNDRY_PROFILE`: the Tron path ships the default
 * build, and the profile most likely to be left exported in a shell is `solc_floor`, whose
 * london/0.8.17 output shares `out/` with it.
 *
 * @param repoRoot - Directory holding `foundry.toml`.
 * @returns The default profile's compiler settings.
 * @throws When `foundry.toml` cannot be read or parsed, or does not pin `solc_version` and
 * `evm_version` in `[profile.default]`.
 */
export function readDefaultBuildProfile(repoRoot: string): IForgeBuildProfile {
  const path = join(repoRoot, 'foundry.toml')
  let profile: unknown
  try {
    profile = (
      parse(readFileSync(path, 'utf8')) as { profile?: { default?: unknown } }
    ).profile?.default
  } catch (error: unknown) {
    const reason =
      error instanceof Error ? error.message.split('\n')[0] : String(error)
    throw new ForgeArtifactBuildError(
      `Cannot read the build profile from ${path} (${reason}), so the artifact's compiler ` +
        'cannot be checked. Run the Tron deploy scripts from the Forge project root.'
    )
  }

  const body = isRecord(profile) ? profile : {}
  const {
    solc_version: solc,
    evm_version: evm,
    optimizer,
    optimizer_runs: runs,
  } = body
  if (typeof solc !== 'string' || typeof evm !== 'string')
    throw new ForgeArtifactBuildError(
      `${path} does not pin solc_version and evm_version in [profile.default], so the ` +
        "artifact's compiler cannot be checked against it."
    )

  return {
    solcVersion: solc,
    evmVersion: evm,
    ...(typeof optimizer === 'boolean' ? { optimizer } : {}),
    ...(typeof runs === 'number' ? { optimizerRuns: runs } : {}),
    viaIr: body.via_ir === true,
  }
}

/**
 * Refuses an artifact not compiled by the default profile's solc version and settings.
 *
 * @param artifact - The Forge artifact about to be deployed.
 * @param contractName - Named in every message.
 * @param repoRoot - Forge project root holding `foundry.toml`.
 * @throws {ForgeArtifactBuildError} When the artifact records a different solc version,
 * EVM version, optimizer setting or IR pipeline, or records none of them.
 */
export function assertArtifactBuiltWithDefaultProfile(
  artifact: { metadata?: unknown },
  contractName: string,
  repoRoot: string
): void {
  const expected = readDefaultBuildProfile(repoRoot)
  const metadata = readMetadata(artifact)
  const compiler = isRecord(metadata.compiler) ? metadata.compiler : {}
  const settings = isRecord(metadata.settings) ? metadata.settings : {}
  const optimizer = isRecord(settings.optimizer) ? settings.optimizer : {}

  const builtSolc = String(compiler.version ?? 'none')
  const builtViaIr = settings.viaIR === true
  const differences: string[] = []
  if (builtSolc.split('+')[0] !== expected.solcVersion)
    differences.push(`solc ${builtSolc}, expected ${expected.solcVersion}`)
  if (settings.evmVersion !== expected.evmVersion)
    differences.push(
      `evmVersion ${String(settings.evmVersion)}, expected ${
        expected.evmVersion
      }`
    )
  if (
    expected.optimizer !== undefined &&
    optimizer.enabled !== expected.optimizer
  )
    differences.push(
      `optimizer ${String(optimizer.enabled)}, expected ${expected.optimizer}`
    )
  if (
    expected.optimizerRuns !== undefined &&
    optimizer.runs !== expected.optimizerRuns
  )
    differences.push(
      `optimizer runs ${String(optimizer.runs)}, expected ${
        expected.optimizerRuns
      }`
    )
  if (builtViaIr !== expected.viaIr)
    differences.push(`viaIR ${builtViaIr}, expected ${expected.viaIr}`)

  if (differences.length > 0)
    throw new ForgeArtifactBuildError(
      `${contractName}: the Forge artifact was not built with [profile.default] of ` +
        `foundry.toml (${differences.join(
          '; '
        )}), so a rebuild of this version ` +
        'would not reproduce it. Unset FOUNDRY_PROFILE and check `forge --version`. ' +
        REBUILD
    )
}

const readArtifactSources = (artifact: {
  metadata?: unknown
}): Record<string, unknown> | undefined => {
  const { sources } = readMetadata(artifact)
  return isRecord(sources) && Object.keys(sources).length > 0
    ? sources
    : undefined
}

/**
 * Reads a source file, or says why it cannot be read.
 *
 * @returns The bytes, or the reason in place of them.
 */
const readSource = (file: string): Buffer | string => {
  try {
    return readFileSync(file)
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code
    return code === 'ENOENT'
      ? 'not on disk'
      : `unreadable: ${String(code ?? error)}`
  }
}

/**
 * Refuses a Forge artifact that was not compiled from the source files now on disk.
 *
 * solc records the keccak256 of every source file's exact bytes in `metadata.sources`; any
 * difference, whitespace included, means the build is stale. Every call re-reads and
 * re-hashes the artifact's whole source closure; nothing is cached.
 *
 * @param artifact - The Forge artifact about to be deployed.
 * @param contractName - Named in every message.
 * @param sourceRoot - Directory the artifact's source paths are relative to; the Forge
 * project root, which is where `loadForgeArtifact` reads `out/` from by default.
 * @throws {ForgeArtifactBuildError} When any source file differs from the one compiled, or
 * the artifact cannot be checked: no readable `metadata.sources`, an entry without a
 * well-formed hash, or a file that is missing or cannot be read.
 */
export function assertArtifactBuiltFromCurrentSource(
  artifact: { metadata?: unknown },
  contractName: string,
  sourceRoot: string
): void {
  const uncheckable = `${contractName}: the Forge artifact cannot be checked against the source`
  const sources = readArtifactSources(artifact)
  if (!sources)
    throw new ForgeArtifactBuildError(
      `${uncheckable}: it holds no readable metadata.sources. ${REBUILD}`
    )

  const unverifiable: string[] = []
  const changed: string[] = []
  for (const [path, entry] of Object.entries(sources)) {
    const builtHash = isRecord(entry) ? entry.keccak256 : undefined
    if (typeof builtHash !== 'string') {
      unverifiable.push(`${path} (no keccak256)`)
      continue
    }
    const fault = digestFault(builtHash, 'keccak256')
    if (fault !== undefined) {
      unverifiable.push(`${path} (${fault})`)
      continue
    }
    const bytes = readSource(resolve(sourceRoot, path))
    if (typeof bytes === 'string') unverifiable.push(`${path} (${bytes})`)
    else if (normalizeHash(keccak256(bytes)) !== normalizeHash(builtHash))
      changed.push(path)
  }

  if (unverifiable.length > 0)
    throw new ForgeArtifactBuildError(
      `${uncheckable}: ${unverifiable.join(', ')}. ${REBUILD}`
    )
  if (changed.length > 0)
    throw new ForgeArtifactBuildError(
      `${contractName}: the Forge artifact is stale; it was compiled from different source ` +
        'than is on disk, so it would deploy old bytecode under the current version. ' +
        `Changed since the build: ${changed.join(', ')}. ${REBUILD}`
    )
}
