/**
 * Facet version lookups for Safe diamondCut review output.
 * Import from Safe display and review code (e.g. decodeDiamondCut in safe-utils,
 * the sign-time target-state check) to resolve what the deployment record says a
 * proposed facet address is.
 *
 * The intended version deliberately does not live here: it is read from
 * `origin/main` by `pinned-target-state.ts`, never from this checkout.
 */

import * as fs from 'fs'
import * as path from 'path'

interface ICacheRecord {
  contractName?: string
  network?: string
  version?: string
  address?: string
}

const cachedProductionDeploymentRecordsByRoot = new Map<
  string,
  ICacheRecord[] | null
>()

function loadProductionDeploymentRecords(
  rootDir: string = process.cwd()
): ICacheRecord[] | null {
  const base = path.resolve(rootDir)
  const cached = cachedProductionDeploymentRecordsByRoot.get(base)
  if (cached !== undefined) return cached

  try {
    const cachePath = path.resolve(
      base,
      '.cache',
      'deployments_production.json'
    )
    const relative = path.relative(base, cachePath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      cachedProductionDeploymentRecordsByRoot.set(base, null)
      return null
    }
    if (!fs.existsSync(cachePath)) {
      cachedProductionDeploymentRecordsByRoot.set(base, null)
      return null
    }
    const records: unknown = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (!Array.isArray(records)) {
      cachedProductionDeploymentRecordsByRoot.set(base, null)
      return null
    }
    const typedRecords = records as ICacheRecord[]
    cachedProductionDeploymentRecordsByRoot.set(base, typedRecords)
    return typedRecords
  } catch {
    // Transient read/parse faults (e.g. a partially-written cache during a
    // concurrent refresh) must not permanently disable facet-version display —
    // only the deterministic paths above (path escape, missing file, invalid
    // shape) memoize null.
    return null
  }
}

/**
 * Resolves the version of a deployed contract from the deployment cache
 * (`.cache/deployments_production.json`) by matching its address.
 * Only production deployments are considered — the cache file contains
 * production records exclusively.
 * @param contractName - Contract name as used in the cache (e.g. AcrossFacetV4), or null when unknown
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
    const records = loadProductionDeploymentRecords(rootDir)
    if (!records) return null

    const normalizedCandidates = addressCandidates
      .filter((a) => typeof a === 'string' && a.length > 0)
      .map((a) => a.toLowerCase())
    if (normalizedCandidates.length === 0) return null

    const networkLower = network.toLowerCase()

    const matches = (r: ICacheRecord): boolean =>
      r.network?.toLowerCase() === networkLower &&
      typeof r.address === 'string' &&
      normalizedCandidates.includes(r.address.toLowerCase())

    if (contractName) {
      const named = records.find(
        (r) => r.contractName === contractName && matches(r)
      )
      if (named?.version) return named.version
    }

    // Address-based fallback: scan all records on this network
    const found = records.find(matches)
    return found?.version ?? null
  } catch {
    return null
  }
}

/** What the deployment record says a proposed address is. */
export type DeployedContractLookup =
  | {
      kind: 'resolved'
      contractName: string | null
      version: string | null
      /** Whether the record came from the network under review or from the same address elsewhere. */
      recordedOn: 'network' | 'other-networks'
    }
  | { kind: 'ambiguous'; contractNames: string[]; versions: string[] }
  | { kind: 'unrecorded' }

const nonBlank = (value: string | undefined): string | null => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

/**
 * Resolves the contract name and version a deployed address was recorded under,
 * from the deployment cache (`.cache/deployments_production.json`).
 *
 * The cache mirrors the MongoDB deployment record, which the deploy script writes
 * *before* proposing — unlike `deployments/<network>.json`, which merges only
 * after execution and so lags every new deployment.
 *
 * A `(network, address)` pair is not unique in that cache — the live production
 * mirror carries six such pairs, two of them at genuinely different versions —
 * so contradicting records are reported rather than resolved to whichever the
 * unsorted scan reached first. A record carrying no version cannot contradict
 * one that does, which keeps the three blank-sibling pairs resolvable; a record
 * carrying a different *name*, blank version or not, always contradicts.
 *
 * When the network under review has no record at all, the same address on other
 * networks is consulted. An address is a CREATE2 identity, so its bytecode — and
 * therefore its name and version — does not vary by chain, while the record rows
 * do: 13 installed facet addresses have no row on their own network today,
 * robinhood's whole core facet set among them. A name or version disagreement
 * across those rows still refuses.
 * @param network - Network name (e.g. optimism)
 * @param addressCandidates - Address forms to match; compared case-insensitively
 * @param rootDir - Project root containing `.cache/`; defaults to cwd
 * @returns The recorded identity, the contradiction, or that nothing matched
 */
export function resolveDeployedContractByAddress(
  network: string,
  addressCandidates: string[],
  rootDir: string = process.cwd()
): DeployedContractLookup {
  try {
    const records = loadProductionDeploymentRecords(rootDir)
    if (!records) return { kind: 'unrecorded' }

    const normalizedCandidates = addressCandidates
      .filter((a) => typeof a === 'string' && a.length > 0)
      .map((a) => a.toLowerCase())
    if (normalizedCandidates.length === 0) return { kind: 'unrecorded' }

    const atAddress = records.filter(
      (r) =>
        typeof r.address === 'string' &&
        normalizedCandidates.includes(r.address.toLowerCase())
    )
    if (atAddress.length === 0) return { kind: 'unrecorded' }

    const networkLower = network.toLowerCase()
    const onNetwork = atAddress.filter(
      (r) => r.network?.toLowerCase() === networkLower
    )
    const matches = onNetwork.length > 0 ? onNetwork : atAddress
    const recordedOn = onNetwork.length > 0 ? 'network' : 'other-networks'

    // A blank version cannot contradict a present one, so it is dropped before
    // the versions are compared — but the names are taken from every match, or a
    // blank-version sibling could hide a name disagreement.
    const versioned = matches.filter((r) => nonBlank(r.version))
    const versions = [
      ...new Set(
        versioned
          .map((r) => nonBlank(r.version))
          .filter((v): v is string => v !== null)
      ),
    ]
    const contractNames = [
      ...new Set(
        matches
          .map((r) => nonBlank(r.contractName))
          .filter((n): n is string => n !== null)
      ),
    ]

    if (versions.length > 1 || contractNames.length > 1)
      return { kind: 'ambiguous', contractNames, versions }

    return {
      kind: 'resolved',
      contractName: contractNames[0] ?? null,
      version: versions[0] ?? null,
      recordedOn,
    }
  } catch {
    return { kind: 'unrecorded' }
  }
}
