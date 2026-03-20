import { relative, resolve } from 'path'

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
    try {
      const content = await Bun.file(fullPath).text()
      const versionMatch = content.match(/@custom:version\s+(\S+)/)
      if (versionMatch && versionMatch[1]) return versionMatch[1]
    } catch {
      // Try next path
    }
  }

  throw new Error(`Could not find version for ${contractName}`)
}
