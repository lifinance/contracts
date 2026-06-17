/**
 * Facet version lookups for Safe diamondCut review output.
 * Import from Safe display code (e.g. decodeDiamondCut in safe-utils) to resolve
 * the deployed version of a facet from the deployment log and the intended
 * version from the target state file.
 */

import * as fs from 'fs'
import * as path from 'path'

interface ICacheRecord {
  contractName?: string
  network?: string
  version?: string
  address?: string
}

/**
 * Resolves the version of a deployed contract from the deployment cache
 * (`.cache/deployments_production.json`) by matching its address.
 * Only production deployments are considered — the cache file contains
 * production records exclusively.
 * @param contractName - Contract name as used in the cache (e.g. AcrossFacetV3), or null when unknown
 * @param network - Network name (e.g. optimism)
 * @param addressCandidates - Address forms to match; compared case-insensitively
 * @param rootDir - Project root containing `.cache/`; defaults to cwd
 * @returns Version string if exactly resolvable, otherwise null
 */
export function getDeployedFacetVersionFromLog(
  contractName: string | null,
  network: string,
  addressCandidates: string[],
  rootDir: string = process.cwd()
): string | null {
  try {
    const cachePath = path.join(
      rootDir,
      '.cache',
      'deployments_production.json'
    )
    if (!fs.existsSync(cachePath)) return null
    const records: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (!Array.isArray(records)) return null

    const normalizedCandidates = addressCandidates
      .filter((a) => typeof a === 'string' && a.length > 0)
      .map((a) => a.toLowerCase())
    if (normalizedCandidates.length === 0) return null

    const typedRecords = records as ICacheRecord[]
    const networkLower = network.toLowerCase()

    const matches = (r: ICacheRecord): boolean =>
      r.network?.toLowerCase() === networkLower &&
      typeof r.address === 'string' &&
      normalizedCandidates.includes(r.address.toLowerCase())

    if (contractName) {
      const named = typedRecords.find(
        (r) => r.contractName === contractName && matches(r)
      )
      if (named?.version) return named.version
    }

    // Address-based fallback: scan all records on this network
    const found = typedRecords.find(matches)
    return found?.version ?? null
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
