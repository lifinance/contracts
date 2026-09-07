/**
 * Toolchain pre-flight for the Tron deploy path.
 *
 * Tron contracts are deployed from Forge artifacts that are built beforehand by a plain
 * `forge build`, and the bytecode that reaches chain is whatever that build produced. The
 * EVM deploy path refuses when the local forge does not match `.foundry-version`; nothing
 * gated the Tron path, so a drifted forge could put bytecode on chain that no later rebuild
 * reproduces.
 *
 * This checks the forge that is about to run, not the one that built the artifacts on
 * disk, and those can differ: build with a drifted forge, `foundryup` back to the pin, and
 * the deploy passes over bytecode no rebuild reproduces. Closing that needs the compiler
 * version read out of the artifact's own metadata; until then the guarantee is "the
 * toolchain here is the pinned one", not "these artifacts were built with it".
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

/**
 * Runs the real checker through bash.
 *
 * @param checkerPath - Absolute path of the checker script.
 * @returns Its exit status and combined output.
 */
export const spawnFoundryVersionChecker: TCheckerRunner = (checkerPath) => {
  const result = spawnSync('bash', [checkerPath, '--quiet'], {
    encoding: 'utf8',
    // Passed explicitly: bun's spawnSync snapshots the environment it was started with, so
    // a child would not see the PATH the caller is actually running under.
    env: { ...process.env },
  })
  return {
    status: result.error ? null : result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}${
      result.error ? result.error.message : ''
    }`.trim(),
  }
}

/** Set once the checker has passed in this process, so N deployments cost one spawn. */
// Keyed by the repo root it was confirmed for, not a bare flag: a pass for one checkout
// must not authorise another, and the flag was read before the root was even resolved.
const confirmedRoots = new Set<string>()

/** Clears the per-process pass so the next call re-runs the checker. */
export const resetTronToolchainCache = (): void => {
  confirmedRoots.clear()
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
