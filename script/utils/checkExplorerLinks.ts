import fs from 'fs'
import path from 'path'

import { consola } from 'consola'

import networksConfig from '../../config/networks.json'

import { buildExplorerAddressUrl } from './viemScriptHelpers'

interface INetworksConfig {
  [key: string]: {
    chainId: number
    explorerUrl?: string
    status?: string
  }
}

interface IExplorerCheckResult {
  network: string
  url: string | undefined
  ok: boolean
  statusCode?: number
  error?: string
}

const networks = networksConfig as INetworksConfig

function getExampleAddressForNetwork(network: string): string | undefined {
  const fileBase = path.resolve(`deployments/${network}.json`)
  if (!fs.existsSync(fileBase)) return undefined

  const deployments = JSON.parse(fs.readFileSync(fileBase, 'utf-8')) as Record<
    string,
    string
  >

  // Prefer LiFiDiamond if present, otherwise take the first address
  if (deployments.LiFiDiamond) return deployments.LiFiDiamond

  const firstAddress = Object.values(deployments)[0]
  if (typeof firstAddress === 'string') return firstAddress

  return undefined
}

async function headOrGet(
  url: string
): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(url, { method: 'HEAD' })
    if (res.ok || (res.status >= 300 && res.status < 400))
      return { ok: true, status: res.status }

    // Some explorers may not support HEAD properly – fall back to GET once.
    const resGet = await fetch(url, { method: 'GET' })
    return { ok: resGet.ok, status: resGet.status }
  } catch {
    return { ok: false, status: 0 }
  }
}

export async function checkExplorerLinks(): Promise<void> {
  const results: IExplorerCheckResult[] = []

  for (const [networkId, cfg] of Object.entries(networks)) {
    if (cfg.status === 'inactive') continue

    const exampleAddress = getExampleAddressForNetwork(networkId)
    const url = exampleAddress
      ? buildExplorerAddressUrl(networkId, exampleAddress)
      : undefined

    if (!url) {
      results.push({
        network: networkId,
        url,
        ok: false,
        error: 'No explorer URL or example address available',
      })
      continue
    }

    const { ok, status } = await headOrGet(url)
    results.push({
      network: networkId,
      url,
      ok,
      statusCode: status,
      error: ok ? undefined : `HTTP ${status}`,
    })
  }

  consola.info('Explorer URL check results:')
  for (const r of results)
    if (r.ok)
      consola.success(
        `${r.network.padEnd(12)} -> OK (${r.statusCode ?? 'n/a'}) - ${r.url}`
      )
    else
      consola.warn(
        `${r.network.padEnd(12)} -> FAIL (${
          r.statusCode ?? r.error ?? 'unknown'
        }) - ${r.url ?? 'n/a'}`
      )

  const problematic = results.filter((r) => !r.ok)
  if (problematic.length) {
    consola.info('\nNetworks that may need custom explorer URL templates:')
    problematic.forEach((r) => consola.info(`- ${r.network}`))
  }
}

// Small runner so this can be invoked directly via `bunx tsx`.
if (require.main === module) {
  // Intentionally avoid top-level await for compatibility with all runners.
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  checkExplorerLinks()
    .then(() => {
      consola.info('Finished checking explorer links.')
    })
    .catch((error) => {
      consola.error('Error while checking explorer links:', error)
      process.exit(1)
    })
}
