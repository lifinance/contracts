import { existsSync, readdirSync, readFileSync } from 'fs'
import { resolve } from 'path'

import { consola } from 'consola'

const REPO_ROOT = resolve(import.meta.dir, '../..')

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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function loadSources(repoRoot: string = REPO_ROOT): INetworkSources[] {
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
    for (const a of m.addresses) consola.log(`    ${a.address}  (${a.source})`)
  }
}

if (import.meta.main) {
  const mismatches = findMismatches(loadSources())
  if (mismatches.length > 0) {
    report(mismatches)
    consola.error(
      `Found ${mismatches.length} address mismatch(es) across deployment files.`
    )
    process.exit(1)
  }
  consola.success('Deployment address consistency check passed.')
}
