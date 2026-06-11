/**
 * Validates that contract addresses are consistent across `config/whitelist.json`,
 * `deployments/<network>.json`, and `deployments/<network>.diamond.json`.
 * Import `findMismatches`/`loadSources` for programmatic use, or run directly as a CLI
 * (exits 1 on any mismatch).
 */

import { execSync } from 'child_process'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

import { consola } from 'consola'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export interface INetworkSources {
  network: string
  whitelistPeriphery: Record<string, string>
  deploymentFlat: Record<string, string>
  diamondPeriphery: Record<string, string>
  diamondFacets: Record<string, string>
}

export interface IMismatch {
  network: string
  kind: 'periphery' | 'facet'
  contract: string
  addresses: { source: string; address: string }[]
}

export interface ICoverageGap {
  network: string
  contract: string
  address: string
}

const isEmpty = (address?: string): boolean => !address || address.trim() === ''
const normalize = (address: string): string => address.trim().toLowerCase()

function checkContract(
  network: string,
  kind: IMismatch['kind'],
  contract: string,
  entries: { source: string; address?: string }[]
): IMismatch | null {
  const present = entries.filter(
    (e): e is { source: string; address: string } => !isEmpty(e.address)
  )
  if (present.length < 2) return null
  const reference = normalize(present[0]?.address ?? '')
  const disagrees = present.some((e) => normalize(e.address) !== reference)
  return disagrees ? { network, kind, contract, addresses: present } : null
}

/**
 * Finds address mismatches across the provided network sources.
 *
 * @param sources - Array of per-network source data produced by `loadSources`.
 * @returns Array of mismatches found; empty array means all addresses are consistent.
 *
 * @remarks
 * A contract is only flagged when **two or more** sources have a non-empty address that
 * disagree with each other — empty or absent entries are silently ignored ("agree where
 * present" semantics). For facets, the cross-check is driven by the set of facets
 * installed in the diamond (`diamondFacets`); a facet that appears only in the flat
 * deployment log but has not yet been cut into the diamond will not be cross-checked.
 */
export function findMismatches(sources: INetworkSources[]): IMismatch[] {
  const mismatches: IMismatch[] = []
  for (const s of sources) {
    const peripheryNames = new Set([
      ...Object.keys(s.whitelistPeriphery),
      ...Object.keys(s.diamondPeriphery),
    ])
    for (const name of peripheryNames) {
      const m = checkContract(s.network, 'periphery', name, [
        {
          source: 'config/whitelist.json',
          address: s.whitelistPeriphery[name],
        },
        {
          source: `deployments/${s.network}.json`,
          address: s.deploymentFlat[name],
        },
        {
          source: `deployments/${s.network}.diamond.json`,
          address: s.diamondPeriphery[name],
        },
      ])
      if (m) mismatches.push(m)
    }
    for (const name of Object.keys(s.diamondFacets)) {
      const m = checkContract(s.network, 'facet', name, [
        {
          source: `deployments/${s.network}.json`,
          address: s.deploymentFlat[name],
        },
        {
          source: `deployments/${s.network}.diamond.json`,
          address: s.diamondFacets[name],
        },
      ])
      if (m) mismatches.push(m)
    }
  }
  return mismatches
}

/**
 * Finds whitelist-eligible periphery contracts that are deployed (present and
 * non-empty in `<network>.diamond.json`) but missing from `config/whitelist.json`.
 *
 * @param sources - Per-network source data from `loadSources`.
 * @param whitelistEligible - Periphery names that are expected to be whitelisted
 *   (the keys of `config/global.json` → `whitelistPeripheryFunctions`).
 * @returns One gap per eligible, deployed-but-unwhitelisted periphery; empty if none.
 * @remarks Only periphery names in `whitelistEligible` are considered, so contracts
 *   that are intentionally never whitelisted (Receivers, proxies, Executor) are ignored.
 */
export function findCoverageGaps(
  sources: INetworkSources[],
  whitelistEligible: Set<string>
): ICoverageGap[] {
  const gaps: ICoverageGap[] = []
  for (const s of sources) {
    for (const [name, address] of Object.entries(s.diamondPeriphery)) {
      if (!whitelistEligible.has(name)) continue
      if (!address || address.trim() === '') continue
      if (isEmpty(s.whitelistPeriphery[name]))
        gaps.push({ network: s.network, contract: name, address })
    }
  }
  return gaps
}

/**
 * Derives the set of network names affected by a set of staged file paths.
 *
 * @param stagedPaths - Repo-relative paths reported by `git diff --cached --name-only`.
 * @param changedWhitelistNetworks - Network names whose entries changed in `config/whitelist.json`.
 * @returns Set of network names that should be checked for address consistency.
 */
export function affectedNetworks(
  stagedPaths: string[],
  changedWhitelistNetworks: string[]
): Set<string> {
  const networks = new Set<string>(changedWhitelistNetworks)
  for (const p of stagedPaths) {
    const diamondMatch = p.match(/^deployments\/(.+)\.diamond\.json$/)
    if (diamondMatch) {
      networks.add(diamondMatch[1] as string)
      continue
    }
    const flatMatch = p.match(/^deployments\/(.+)\.json$/)
    if (
      flatMatch &&
      !p.includes('.staging') &&
      p !== 'deployments/_deployments_log_file.json'
    )
      networks.add(flatMatch[1] as string)
  }
  return networks
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

/**
 * Loads per-network address data from the repo's config and deployment files.
 *
 * @param repoRoot - Absolute path to the repository root. Defaults to the repo root
 *   relative to this file's location.
 * @param filter - When provided, only networks whose name is in this set are loaded.
 *   Omit to load all networks.
 * @returns Array of `INetworkSources`, one entry per network discovered in either
 *   `config/whitelist.json` or any `deployments/<network>.diamond.json` file.
 * @throws If `config/whitelist.json` is missing or contains malformed JSON.
 */
export function loadSources(
  repoRoot: string = REPO_ROOT,
  filter?: Set<string>
): INetworkSources[] {
  const whitelistByNetwork =
    readJson<{
      PERIPHERY?: Record<string, { name: string; address: string }[]>
    }>(`${repoRoot}/config/whitelist.json`).PERIPHERY ?? {}

  const deploymentsDir = `${repoRoot}/deployments`
  const diamondNetworks = readdirSync(deploymentsDir)
    .filter((f) => f.endsWith('.diamond.json') && !f.includes('.staging'))
    .map((f) => f.replace('.diamond.json', ''))

  const networks = new Set<string>([
    ...Object.keys(whitelistByNetwork),
    ...diamondNetworks,
  ])

  const sources: INetworkSources[] = []
  for (const network of networks) {
    if (filter && !filter.has(network)) continue
    const whitelistPeriphery: Record<string, string> = {}
    for (const entry of whitelistByNetwork[network] ?? [])
      whitelistPeriphery[entry.name] = entry.address

    const flatPath = `${deploymentsDir}/${network}.json`
    const deploymentFlat: Record<string, string> = existsSync(flatPath)
      ? readJson<Record<string, string>>(flatPath)
      : {}

    const diamondPath = `${deploymentsDir}/${network}.diamond.json`
    let diamondPeriphery: Record<string, string> = {}
    const diamondFacets: Record<string, string> = {}
    if (existsSync(diamondPath)) {
      const diamond =
        readJson<{
          LiFiDiamond?: {
            Periphery?: Record<string, string>
            Facets?: Record<string, { Name?: string; Version?: string }>
          }
        }>(diamondPath).LiFiDiamond ?? {}
      diamondPeriphery = diamond.Periphery ?? {}
      for (const [address, info] of Object.entries(diamond.Facets ?? {}))
        if (info?.Name) diamondFacets[info.Name] = address
    }

    sources.push({
      network,
      whitelistPeriphery,
      deploymentFlat,
      diamondPeriphery,
      diamondFacets,
    })
  }
  return sources
}

/**
 * Reads the set of whitelist-eligible periphery names from
 * `config/global.json` → `whitelistPeripheryFunctions`.
 * @param repoRoot - Repository root. Defaults to this repo.
 * @returns Set of eligible periphery contract names (empty if the key is absent).
 */
export function loadWhitelistEligible(
  repoRoot: string = REPO_ROOT
): Set<string> {
  const fns = readJson<{
    whitelistPeripheryFunctions?: Record<string, unknown>
  }>(`${repoRoot}/config/global.json`).whitelistPeripheryFunctions
  return new Set(Object.keys(fns ?? {}))
}

function report(mismatches: IMismatch[]): void {
  for (const m of mismatches) {
    consola.error(`[${m.network}] ${m.kind} "${m.contract}" address mismatch:`)
    const reference = normalize(m.addresses[0]?.address ?? '')
    for (const a of m.addresses) {
      const prefix = normalize(a.address) !== reference ? '  ✗ ' : '    '
      consola.log(`${prefix}${a.address}  (${a.source})`)
    }
  }
}

function reportCoverageGaps(gaps: ICoverageGap[]): void {
  for (const g of gaps)
    consola.error(
      `[${g.network}] periphery "${g.contract}" (${g.address}) is in deployments/${g.network}.diamond.json but missing from config/whitelist.json`
    )
}

/**
 * Determines which networks' periphery whitelist entries changed between two
 * `PERIPHERY` maps, comparing only each contract's name + (lowercased) address.
 * Ignores entry ordering, object-key ordering, selector changes, and address case,
 * so reformatting the file does not spuriously widen the gate's scope.
 *
 * @param staged - PERIPHERY object from the staged whitelist (network -> entries[]).
 * @param head - PERIPHERY object from the HEAD whitelist.
 * @returns Names of networks whose name->address projection differs.
 */
export function changedWhitelistNetworks(
  staged: Record<string, unknown>,
  head: Record<string, unknown>
): string[] {
  // Returns null when the network key is absent (distinguishes "missing" from
  // "present but empty"), otherwise a stable JSON fingerprint of name+address pairs.
  const project = (
    map: Record<string, unknown>,
    network: string
  ): string | null => {
    if (!(network in map)) return null
    const entries = map[network]
    const list = Array.isArray(entries)
      ? (entries as { name?: string; address?: string }[])
      : []
    return JSON.stringify(
      list
        .map((e) => [e.name ?? '', (e.address ?? '').toLowerCase()] as const)
        .sort((a, b) => a[0].localeCompare(b[0]))
    )
  }
  const networks = new Set([...Object.keys(staged), ...Object.keys(head)])
  return [...networks].filter((n) => project(staged, n) !== project(head, n))
}

/**
 * Repo-relative paths staged in the git index (ACMR filter).
 *
 * @param repoRoot - Repository root to run git in. Defaults to this repo.
 * @returns Staged paths, newline-split, empties removed.
 * @throws When not run inside a git repository.
 */
export function getStagedPaths(repoRoot: string = REPO_ROOT): string[] {
  return execSync('git diff --cached --name-only --diff-filter=ACMR', {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => p.length > 0)
}

/**
 * Networks whose `config/whitelist.json` PERIPHERY entry changed between the
 * staged index version and HEAD. Empty when whitelist.json is not staged.
 *
 * @param stagedPaths - Output of `getStagedPaths`.
 * @param repoRoot - Repository root to run git in. Defaults to this repo.
 */
export function getChangedWhitelistNetworks(
  stagedPaths: string[],
  repoRoot: string = REPO_ROOT
): string[] {
  if (!stagedPaths.includes('config/whitelist.json')) return []
  const parsePeriphery = (revSpec: string): Record<string, unknown> => {
    try {
      const raw = execSync(`git show ${revSpec}`, {
        cwd: repoRoot,
        encoding: 'utf8',
      })
      return (JSON.parse(raw).PERIPHERY ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return changedWhitelistNetworks(
    parsePeriphery(':config/whitelist.json'),
    parsePeriphery('HEAD:config/whitelist.json')
  )
}

if (import.meta.main) {
  try {
    const staged = process.argv.includes('--staged')
    const eligible = loadWhitelistEligible()
    let sources: INetworkSources[]
    if (staged) {
      const stagedPaths = getStagedPaths()
      const scope = affectedNetworks(
        stagedPaths,
        getChangedWhitelistNetworks(stagedPaths)
      )
      if (scope.size === 0) {
        consola.info('No staged whitelist/deployment files to check.')
        process.exit(0)
      }
      sources = loadSources(REPO_ROOT, scope)
    } else {
      sources = loadSources()
    }
    const mismatches = findMismatches(sources)
    const gaps = findCoverageGaps(sources, eligible)
    report(mismatches)
    reportCoverageGaps(gaps)
    if (mismatches.length > 0 || gaps.length > 0) {
      consola.error(
        `Found ${mismatches.length} address mismatch(es) and ${gaps.length} whitelist coverage gap(s).`
      )
      process.exit(1)
    }
    consola.success('Deployment address consistency check passed.')
  } catch (error) {
    consola.error('Failed to run deployment address consistency check:', error)
    process.exit(1)
  }
}
