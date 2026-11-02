/**
 * Refuses a Tron diamondCut whose selectors would come from an artifact other than the one
 * the facet on chain was built from. `register-facets-to-diamond` reads selectors from `out/`,
 * so it calls this before any cut is sent.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { stripMetadataTrailer } from '../../codehash/bytecode-trailer'
import {
  maskImmutables,
  type ImmutableReferences,
} from '../../codehash/immutable-offsets'

/** The parts of a Forge artifact that identify its runtime code. */
export interface IRuntimeArtifact {
  deployedBytecode?: { object?: string }
  immutableReferences?: ImmutableReferences
}

/** Reads a contract's runtime code, `0x`-prefixed, or undefined when there is none. */
export type TRuntimeCodeReader = (
  address: string
) => Promise<string | undefined>

/**
 * Compares on-chain runtime code with an artifact, ignoring immutable values and the
 * metadata trailer: neither changes which selectors the code dispatches.
 *
 * @param onChain - Runtime code read from chain, `0x`-prefixed, or undefined.
 * @param artifact - The Forge artifact the selectors would be read from.
 * @returns Why they differ, or undefined when they match.
 */
export const describeCodeMismatch = (
  onChain: string | undefined,
  artifact: IRuntimeArtifact
): string | undefined => {
  const built = artifact.deployedBytecode?.object
  if (!built || built === '0x') return 'the artifact has no deployedBytecode'
  if (!onChain || onChain === '0x') return 'no code at that address'
  if (onChain.length !== built.length)
    return `on-chain code is ${
      (onChain.length - 2) / 2
    } bytes, the artifact's ${(built.length - 2) / 2}`

  const masked = maskImmutables(onChain, artifact.immutableReferences)
  if (!masked.ok) return `cannot mask immutables: ${masked.reason}`

  const deployed = stripMetadataTrailer(masked.code).code.toLowerCase()
  const expected = stripMetadataTrailer(built).code.toLowerCase()
  return deployed === expected ? undefined : 'on-chain code differs'
}

/**
 * Refuses unless each facet's on-chain code matches its artifact in `out/`.
 *
 * @param options.facets - Facet name mapped to its deployed address.
 * @param options.readRuntimeCode - Reads a facet's runtime code from chain.
 * @param options.outRoot - Forge output directory the selectors are read from.
 * @throws When any facet's code cannot be shown to match its artifact.
 */
export async function assertFacetCodeMatchesArtifacts(options: {
  facets: Record<string, string>
  readRuntimeCode: TRuntimeCodeReader
  outRoot: string
}): Promise<void> {
  const entries = Object.entries(options.facets)
  const onChain = await Promise.all(
    entries.map(([, address]) => options.readRuntimeCode(address))
  )

  const mismatches: string[] = []
  entries.forEach(([name, address], index) => {
    const path = join(options.outRoot, `${name}.sol`, `${name}.json`)
    const mismatch = existsSync(path)
      ? describeCodeMismatch(
          onChain[index],
          JSON.parse(readFileSync(path, 'utf8')) as IRuntimeArtifact
        )
      : `artifact not found at ${path}`
    if (mismatch) mismatches.push(`${name} (${address}): ${mismatch}`)
  })

  if (mismatches.length > 0)
    throw new Error(
      `${mismatches.length} facet(s) on chain were not built from the artifacts in ${options.outRoot}, ` +
        'so their selectors cannot be read from this checkout. Check out the commit they ' +
        'were deployed from and retry. Nothing has been broadcast.\n' +
        mismatches.join('\n')
    )
}
