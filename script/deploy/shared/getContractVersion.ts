import { readFile } from 'node:fs/promises'
import { relative, resolve } from 'path'

import { readContractVersion } from './contract-version'

/** Solidity-style contract name (no path segments, so reads stay under `src/`). */
const CONTRACT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Get contract version from source file
 */
export async function getContractVersion(
  contractName: string
): Promise<string> {
  if (!CONTRACT_NAME_RE.test(contractName)) {
    throw new Error(
      `Invalid contract name "${contractName}": expected a Solidity identifier`
    )
  }

  const projectRoot = resolve(process.cwd())
  const srcRoot = resolve(projectRoot, 'src')

  const possiblePaths = [
    `src/${contractName}.sol`,
    `src/Facets/${contractName}.sol`,
    `src/Periphery/${contractName}.sol`,
    `src/Security/${contractName}.sol`,
  ]

  for (const relativePath of possiblePaths) {
    const fullPath = resolve(projectRoot, relativePath)
    const underSrc = relative(srcRoot, fullPath)
    if (underSrc.startsWith('..') || underSrc === '') {
      continue
    }
    let content: string
    try {
      content = await readFile(fullPath, 'utf8')
    } catch {
      continue // Try next path
    }

    // Read outside the catch above: a version that is present but malformed is
    // a fault in this file, not a reason to go on guessing paths.
    const read = readContractVersion(content)
    if (read.kind === 'malformed')
      throw new Error(
        `'${read.raw}' in ${relativePath} is not a @custom:version (expected MAJOR.MINOR.PATCH with an optional lowercase -suffix)`
      )
    if (read.kind === 'ok') return read.version
  }

  throw new Error(`Could not find version for ${contractName}`)
}
