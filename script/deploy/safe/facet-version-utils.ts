/**
 * Facet version lookups for Safe diamondCut review output.
 * Import from Safe display code (e.g. decodeDiamondCut in safe-utils) to resolve
 * the deployed version of a facet from the deployment log and the intended
 * version from the target state file.
 */

import * as fs from 'fs'
import * as path from 'path'

interface IDeploymentLogEntry {
  ADDRESS?: string
}

/**
 * Resolves the version of a deployed contract from the deployment log
 * (`deployments/_deployments_log_file.json`) by matching its address.
 * Only production deployments are considered, mirroring confirm-safe-tx's
 * production-only contract-name resolution.
 * @param contractName - Contract name as used in the deployment log (e.g. AcrossFacetV3), or null when unknown
 * @param network - Network name (e.g. optimism)
 * @param addressCandidates - Address forms to match (e.g. raw hex and network-formatted); compared case-insensitively
 * @param rootDir - Project root containing `deployments/`; defaults to cwd
 * @returns Version string if exactly resolvable, otherwise null
 */
export function getDeployedFacetVersionFromLog(
  contractName: string | null,
  network: string,
  addressCandidates: string[],
  rootDir: string = process.cwd()
): string | null {
  try {
    const logPath = path.join(
      rootDir,
      'deployments',
      '_deployments_log_file.json'
    )
    if (!fs.existsSync(logPath)) return null
    const log: unknown = JSON.parse(fs.readFileSync(logPath, 'utf8'))
    if (typeof log !== 'object' || log === null) return null

    const normalizedCandidates = addressCandidates
      .filter((a) => typeof a === 'string' && a.length > 0)
      .map((a) => a.toLowerCase())
    if (normalizedCandidates.length === 0) return null

    const typedLog = log as Record<
      string,
      Record<string, Record<string, Record<string, IDeploymentLogEntry[]>>>
    >

    const findInVersions = (
      versions: Record<string, IDeploymentLogEntry[]> | undefined
    ): string | null => {
      if (!versions || typeof versions !== 'object') return null
      for (const [version, entries] of Object.entries(versions)) {
        if (!Array.isArray(entries)) continue
        for (const entry of entries) {
          const entryAddress = entry?.ADDRESS
          if (
            typeof entryAddress === 'string' &&
            normalizedCandidates.includes(entryAddress.toLowerCase())
          )
            return version
        }
      }
      return null
    }

    if (contractName) {
      const named = findInVersions(
        typedLog[contractName]?.[network]?.['production']
      )
      if (named) return named
    }

    // Address-based fallback: a deployed address is unique per network, so a
    // full scan still resolves the version when the name subtree misses
    // (unresolved or differently-named contract).
    for (const perNetwork of Object.values(typedLog)) {
      const found = findInVersions(perNetwork?.[network]?.['production'])
      if (found) return found
    }
    return null
  } catch {
    return null
  }
}

/**
 * Resolves the intended version of a contract from the target state file
 * (`script/deploy/_targetState.json`) for the production LiFiDiamond.
 * @param network - Network name (e.g. optimism)
 * @param contractName - Contract name as used in the target state (e.g. AcrossFacetV3)
 * @param rootDir - Project root containing `script/deploy/`; defaults to cwd
 * @returns Target version string if present, otherwise null
 */
export function getTargetStateFacetVersion(
  network: string,
  contractName: string,
  rootDir: string = process.cwd()
): string | null {
  try {
    const targetStatePath = path.join(
      rootDir,
      'script',
      'deploy',
      '_targetState.json'
    )
    if (!fs.existsSync(targetStatePath)) return null
    const targetState: unknown = JSON.parse(
      fs.readFileSync(targetStatePath, 'utf8')
    )
    if (typeof targetState !== 'object' || targetState === null) return null

    const version = (
      targetState as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >
    )[network.toLowerCase()]?.['production']?.['LiFiDiamond']?.[contractName]

    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}
