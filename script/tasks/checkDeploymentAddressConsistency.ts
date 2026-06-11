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

/**
 * Returns the list of repo-relative paths that are staged in the git index.
 */
function getStagedPaths(): string[] {
  return execSync('git diff --cached --name-only --diff-filter=ACMR', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((p) => p.length > 0)
}

/**
 * Returns network names whose `PERIPHERY` entries differ between the staged
 * `config/whitelist.json` and the HEAD version. Returns `[]` when the file is
 * not staged.
 */
function getChangedWhitelistNetworks(stagedPaths: string[]): string[] {
  if (!stagedPaths.includes('config/whitelist.json')) return []
  const parsePeriphery = (ref: string): Record<string, unknown> => {
    try {
      const raw = execSync(`git show ${ref}:config/whitelist.json`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      })
      return (JSON.parse(raw).PERIPHERY ?? {}) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const staged = parsePeriphery(':') // staged/index version
  const head = parsePeriphery('HEAD') // previous committed version
  const networks = new Set([...Object.keys(staged), ...Object.keys(head)])
  return [...networks].filter(
    (n) => JSON.stringify(staged[n]) !== JSON.stringify(head[n])
  )
}

if (import.meta.main) {
  try {
    const staged = process.argv.includes('--staged')
    let mismatches
    if (staged) {
      const stagedPaths = getStagedPaths()
      const scope = affectedNetworks(
        stagedPaths,
        getChangedWhitelistNetworks(stagedPaths)
      )
      if (scope.size === 0) {
        consola.success('No staged whitelist/deployment files to check.')
        process.exit(0)
      }
      mismatches = findMismatches(loadSources(REPO_ROOT, scope))
    } else {
      mismatches = findMismatches(loadSources())
    }
    if (mismatches.length > 0) {
      report(mismatches)
      consola.error(
        `Found ${mismatches.length} address mismatch(es) across deployment files.`
      )
      process.exit(1)
    }
    consola.success('Deployment address consistency check passed.')
  } catch (error) {
    consola.error('Failed to run deployment address consistency check:', error)
    process.exit(1)
  }
}
