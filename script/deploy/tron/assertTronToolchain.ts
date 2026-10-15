/**
 * Toolchain pre-flight for the Tron deploy path.
 *
 * Tron contracts are deployed from Forge artifacts that are built beforehand by a plain
 * `forge build`, and the bytecode that reaches chain is whatever that build produced. The
 * EVM deploy path refuses when the local forge does not match `.foundry-version`; nothing
 * gated the Tron path, so a drifted forge could put bytecode on chain that no later rebuild
 * reproduces.
 *
 * The scripts deploy whatever is in `out/` and label it with the source file's
 * `@custom:version`, so a stale `out/` puts old bytecode on chain under the new version.
 * `buildForgeArtifactsOrThrow` therefore runs `forge build` with the checked forge before
 * any artifact is read, then refuses unless every `src/` artifact records the solc version,
 * EVM version and optimizer runs of `[profile.default]`, as the EVM path does after its
 * rebuild.
 *
 * The comparison is delegated to the same `script/utils/verify-foundry-version.sh` the CI
 * foundry setup and the bash deploy seam run, so there is one verdict rather than a second
 * implementation of it. The checker is resolved relative to the working directory rather
 * than to this file, so the `contracts-tron` checkout gates itself with its own pin.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  getFoundryDefaultEvmVersion,
  getFoundryDefaultOptimizerRuns,
  getFoundryDefaultSolcVersion,
} from '../../utils/utils'

/** Path of the checker, relative to the repository root. */
export const FOUNDRY_VERSION_CHECKER = 'script/utils/verify-foundry-version.sh'

/** What running the checker produced. `status` is null when it could not be started. */
export interface ICheckerResult {
  status: number | null
  output: string
}

/** Runs the checker at an absolute path. */
export type TCheckerRunner = (checkerPath: string) => ICheckerResult

/** Runs `forge build` in a repository root. */
export type TForgeBuildRunner = (repoRoot: string) => ICheckerResult

const toCheckerResult = (
  result: ReturnType<typeof spawnSync>
): ICheckerResult => ({
  status: result.error ? null : result.status,
  output: `${result.stdout ?? ''}${result.stderr ?? ''}${
    result.error ? result.error.message : ''
  }`.trim(),
})

/**
 * Runs the real checker through bash.
 *
 * @param checkerPath - Absolute path of the checker script.
 * @returns Its exit status and combined output.
 */
export const spawnFoundryVersionChecker: TCheckerRunner = (checkerPath) =>
  toCheckerResult(
    spawnSync('bash', [checkerPath, '--quiet'], {
      encoding: 'utf8',
      // Passed explicitly: bun's spawnSync snapshots the environment it was started with,
      // so a child would not see the PATH the caller is actually running under.
      env: { ...process.env },
    })
  )

// 30 minutes: a fresh checkout compiles src/ in a few; past this, forge is stuck.
const FORGE_BUILD_TIMEOUT_MS = 30 * 60 * 1000

/**
 * The environment `forge build` runs under: every `FOUNDRY_*` override removed and
 * `FOUNDRY_PROFILE=default` set explicitly. Removing it is not enough, because forge loads
 * the project's `.env` itself and fills in any variable that is unset.
 *
 * @param env - Environment to derive from. Defaults to this process's.
 * @returns The child environment.
 */
export const forgeBuildEnv = (
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(env).filter(([name]) => !name.startsWith('FOUNDRY_'))
  ),
  FOUNDRY_PROFILE: 'default',
})

/**
 * Runs the real `forge build` of everything but tests, under {@link forgeBuildEnv}. Its
 * output goes straight to the terminal, so a long compile shows progress.
 *
 * @param repoRoot - Directory to build in.
 * @returns Its exit status; the output is already on the terminal.
 */
export const spawnForgeBuild: TForgeBuildRunner = (repoRoot) =>
  toCheckerResult(
    spawnSync('forge', ['build', '--skip', 'test/**'], {
      cwd: repoRoot,
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: FORGE_BUILD_TIMEOUT_MS,
      env: forgeBuildEnv(),
    })
  )

/** The compiler settings of `[profile.default]` that a deployable artifact must record. */
export interface IBuildProfile {
  solcVersion: string
  evmVersion: string
  optimizerRuns: number
}

/**
 * Reads {@link IBuildProfile} from `[profile.default]` of `foundry.toml`.
 *
 * @returns The default profile's compiler settings.
 * @throws When `foundry.toml` does not pin them.
 */
export const readDefaultBuildProfile = (): IBuildProfile => ({
  solcVersion: getFoundryDefaultSolcVersion(),
  evmVersion: getFoundryDefaultEvmVersion(),
  optimizerRuns: getFoundryDefaultOptimizerRuns(),
})

interface IArtifactMetadata {
  compiler?: { version?: string }
  settings?: {
    compilationTarget?: Record<string, string>
    evmVersion?: string
    optimizer?: { runs?: number }
  }
}

const describeMismatch = (
  metadata: IArtifactMetadata | undefined,
  expected: IBuildProfile
): string | undefined => {
  // solc records itself as `0.8.29+commit.ab55807c`; foundry.toml pins the version alone.
  const solc = metadata?.compiler?.version?.split('+')[0]
  const evm = metadata?.settings?.evmVersion
  const runs = metadata?.settings?.optimizer?.runs
  if (
    solc === expected.solcVersion &&
    evm === expected.evmVersion &&
    runs === expected.optimizerRuns
  )
    return undefined
  return `solc ${solc}, evm ${evm}, optimizer runs ${runs}`
}

const readMetadata = (path: string): IArtifactMetadata | undefined =>
  (JSON.parse(readFileSync(path, 'utf8')) as { metadata?: IArtifactMetadata })
    .metadata

/**
 * Refuses unless every artifact compiled from `src/` records the expected compiler settings.
 *
 * @param outRoot - Forge output directory.
 * @param expected - Settings every `src/` artifact must record.
 * @throws When an artifact records other settings, or no `src/` artifact is found.
 */
export function assertSrcArtifactsMatchProfile(
  outRoot: string,
  expected: IBuildProfile
): void {
  const mismatches: string[] = []
  let checked = 0
  const directories = existsSync(outRoot)
    ? readdirSync(outRoot, { withFileTypes: true })
    : []
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    for (const file of readdirSync(join(outRoot, directory.name))) {
      if (!file.endsWith('.json')) continue
      const metadata = readMetadata(join(outRoot, directory.name, file))
      const targets = Object.keys(metadata?.settings?.compilationTarget ?? {})
      if (!targets.some((source) => source.startsWith('src/'))) continue

      checked++
      const mismatch = describeMismatch(metadata, expected)
      if (mismatch) mismatches.push(`${directory.name}/${file}: ${mismatch}`)
    }
  }

  const want = `solc ${expected.solcVersion}, evm ${expected.evmVersion}, optimizer runs ${expected.optimizerRuns}`
  if (checked === 0)
    throw new Error(
      `forge build left no src/ artifact in ${outRoot}, so nothing confirms it was built with ${want}. Refusing to deploy to Tron. Nothing has been broadcast.`
    )
  if (mismatches.length > 0)
    throw new Error(
      `${mismatches.length} artifact(s) in ${outRoot} were not built with [profile.default] (${want}). ` +
        'Remove FOUNDRY_* overrides from .env, run `forge clean`, and retry. ' +
        `Refusing to deploy to Tron. Nothing has been broadcast.\n${mismatches
          .slice(0, 10)
          .join('\n')}`
    )
}

/** Set once the checker has passed in this process, so N deployments cost one spawn. */
// Keyed by the repo root it was confirmed for, not a bare flag: a pass for one checkout
// must not authorise another, and the flag was read before the root was even resolved.
const confirmedRoots = new Set<string>()

/** Roots already built in this process; one build covers every artifact of the run. */
const builtRoots = new Set<string>()

/** Clears the per-process passes so the next call re-runs the checker and the build. */
export const resetTronToolchainCache = (): void => {
  confirmedRoots.clear()
  builtRoots.clear()
}

/**
 * Confirms the toolchain, runs `forge build` so `out/` matches the source on disk, then
 * confirms every `src/` artifact records the `[profile.default]` compiler settings.
 *
 * Call it before the first artifact is read; once per process per root is enough.
 *
 * @param options.repoRoot - Forge project root. Defaults to the working directory.
 * @param options.build - Build runner. Defaults to spawning the real `forge build`.
 * @param options.verify - Post-build check. Defaults to {@link assertSrcArtifactsMatchProfile}
 * of `out/` against `[profile.default]`.
 * @throws When the toolchain check refuses, the build fails, or the post-build check refuses.
 */
export function buildForgeArtifactsOrThrow(options?: {
  repoRoot?: string
  build?: TForgeBuildRunner
  verify?: (repoRoot: string) => void
}): void {
  const repoRoot = options?.repoRoot ?? process.cwd()
  if (builtRoots.has(repoRoot)) return

  assertTronToolchainOrThrow({ repoRoot })
  const { status, output } = (options?.build ?? spawnForgeBuild)(repoRoot)
  if (status !== 0)
    throw new Error(
      `forge build failed in ${repoRoot}, so out/ may not match the source on disk. ` +
        'Fix the build and retry. Nothing has been broadcast.' +
        (output ? `\n${output}` : '')
    )

  const verify =
    options?.verify ??
    ((root: string) =>
      assertSrcArtifactsMatchProfile(
        join(root, 'out'),
        readDefaultBuildProfile()
      ))
  verify(repoRoot)

  builtRoots.add(repoRoot)
}

/**
 * Refuses the Tron deploy path unless the local forge matches the checked-out
 * `.foundry-version`.
 *
 * Only an exit status of 0 permits the deploy: a missing or unrunnable checker refuses too,
 * because "we could not tell" and "it matches" must not share an outcome.
 *
 * @param options.repoRoot - Repository root to resolve the checker against. Defaults to the
 * working directory, which is where these scripts are run from.
 * @param options.run - Checker runner. Defaults to spawning the real checker.
 * @param options.exists - Existence probe for the checker path.
 * @throws When the toolchain cannot be confirmed to match the pin.
 */
export function assertTronToolchainOrThrow(options?: {
  repoRoot?: string
  run?: TCheckerRunner
  exists?: (path: string) => boolean
}): void {
  const repoRoot = options?.repoRoot ?? process.cwd()
  if (confirmedRoots.has(repoRoot)) return

  const run = options?.run ?? spawnFoundryVersionChecker
  const exists = options?.exists ?? existsSync
  const checkerPath = join(repoRoot, FOUNDRY_VERSION_CHECKER)

  if (!exists(checkerPath))
    throw new Error(
      `Foundry version checker not found at ${checkerPath}, so the toolchain that built these artifacts cannot be confirmed. Refusing to deploy to Tron. Nothing has been broadcast.`
    )

  const { status, output } = run(checkerPath)

  if (status !== 0)
    throw new Error(
      `Cannot confirm the local foundry matches ${join(
        repoRoot,
        '.foundry-version'
      )}, so a rebuild would not reproduce this deployment. Refusing to deploy to Tron. Nothing has been broadcast.${
        output ? `\n${output}` : ''
      }`
    )

  confirmedRoots.add(repoRoot)
}
