import { resolve } from 'path'

import { consola } from 'consola'

import type { IForgeArtifact } from '../types'

/**
 * Load compiled contract artifact from Forge output
 */
export async function loadForgeArtifact(
  contractName: string
): Promise<IForgeArtifact> {
  const artifactPath = resolve(
    process.cwd(),
    `out/${contractName}.sol/${contractName}.json`
  )

  try {
    const artifact = await Bun.file(artifactPath).json()

    if (!artifact.abi || !artifact.bytecode?.object)
      throw new Error(
        `Invalid artifact for ${contractName}: missing ABI or bytecode`
      )

    consola.info(`Loaded ${contractName} from: ${artifactPath}`)
    return artifact
  } catch (error: any) {
    throw new Error(`Failed to load ${contractName} artifact: ${error.message}`)
  }
}
