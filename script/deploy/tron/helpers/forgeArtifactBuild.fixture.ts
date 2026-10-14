/**
 * Test fixture: Forge artifact metadata that passes the checks in `forgeArtifactBuild.ts`
 * for a given checkout. Import it from tests that drive the Tron deploy chokepoint without
 * an `out/` directory.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { keccak256 } from 'viem'

import { readDefaultBuildProfile } from './forgeArtifactBuild'

/** solc's default when a profile leaves `optimizer_runs` unset. */
const SOLC_DEFAULT_RUNS = 200

/**
 * Builds the metadata `forge build` with the default profile would record for these files.
 *
 * @param repoRoot - Checkout holding `foundry.toml` and the sources.
 * @param sourcePaths - Source paths relative to `repoRoot`, as solc records them.
 * @returns A `metadata` object for a Forge artifact.
 */
export const metadataBuiltFrom = (
  repoRoot: string,
  sourcePaths: readonly string[]
): Record<string, unknown> => {
  const profile = readDefaultBuildProfile(repoRoot)
  return {
    compiler: { version: `${profile.solcVersion}+commit.00000000` },
    settings: {
      evmVersion: profile.evmVersion,
      optimizer: {
        enabled: profile.optimizer ?? false,
        runs: profile.optimizerRuns ?? SOLC_DEFAULT_RUNS,
      },
      ...(profile.viaIr ? { viaIR: true } : {}),
    },
    sources: Object.fromEntries(
      sourcePaths.map((path) => [
        path,
        { keccak256: keccak256(readFileSync(join(repoRoot, path))) },
      ])
    ),
  }
}
