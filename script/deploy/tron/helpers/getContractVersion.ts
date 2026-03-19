import { resolve } from 'path'

/**
 * Get contract version from source file
 */
export async function getContractVersion(
  contractName: string
): Promise<string> {
  const possiblePaths = [
    `src/${contractName}.sol`,
    `src/Facets/${contractName}.sol`,
    `src/Periphery/${contractName}.sol`,
    `src/Security/${contractName}.sol`,
  ]

  for (const path of possiblePaths) {
    const fullPath = resolve(process.cwd(), path)
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
