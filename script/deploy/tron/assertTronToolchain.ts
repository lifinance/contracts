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
 * any artifact is read; forge recompiles whatever changed since the last build, including a
 * build left by another profile or compiler.
 *
 * The comparison is delegated to the same `script/utils/verify-foundry-version.sh` the CI
 * foundry setup and the bash deploy seam run, so there is one verdict rather than a second
 * implementation of it. The checker is resolved relative to the working directory rather
 * than to this file, so the `contracts-tron` checkout gates itself with its own pin.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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

/**
 * Runs the real `forge build` with every `FOUNDRY_*` override removed, so the build uses
 * `[profile.default]` of `foundry.toml` even when a shell still exports, say,
 * `FOUNDRY_PROFILE=solc_floor`.
 *
 * @param repoRoot - Directory to build in.
 * @returns Its exit status and combined output.
 */
export const spawnForgeBuild: TForgeBuildRunner = (repoRoot) =>
  toCheckerResult(
    spawnSync('forge', ['build'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !name.startsWith('FOUNDRY_')
        )
      ),
    })
  )

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
 * Confirms the toolchain, then runs `forge build` so `out/` matches the source on disk.
 *
 * Call it before the first artifact is read; once per process per root is enough.
 *
 * @param options.repoRoot - Forge project root. Defaults to the working directory.
 * @param options.build - Build runner. Defaults to spawning the real `forge build`.
 * @throws When the toolchain check refuses, or the build fails.
 */
export function buildForgeArtifactsOrThrow(options?: {
  repoRoot?: string
  build?: TForgeBuildRunner
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
