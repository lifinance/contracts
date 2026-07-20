/**
 * Regenerates the `mappings` (chainId -> LayerZero EID) arrays in the per-facet
 * config files from the single source of truth in `config/layerzero.json`.
 *
 * Each consuming facet declares which networks it supports via an existing key in
 * its own config (e.g. FraxFacet -> `hop`, SupersetFacet -> `poolManager`); this
 * task resolves each of those networks to its chainId (via `networks.json`) and
 * its EID (via `layerzero.json`) and writes the resulting `mappings` array back.
 * Networks without an EID in `layerzero.json` are skipped (seed them there first).
 *
 * Run:    bunx tsx tasks/syncLayerZeroEids.ts
 * Verify: bunx tsx tasks/syncLayerZeroEids.ts --check   (exit 1 if out of sync)
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(ROOT, 'config')

export interface IChainIdConfig {
  chainId: number
  lzEid: number
}

// Facets that seed a chainId -> EID mapping, and the config key whose network
// names define the destinations that facet supports.
export const CONSUMERS: { file: string; networksKey: string }[] = [
  { file: 'frax.json', networksKey: 'hop' },
  { file: 'superset.json', networksKey: 'poolManager' },
]

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(CONFIG, file), 'utf8')) as T
}

export function getEids(): Record<string, number> {
  return readJson<{ eids: Record<string, number> }>('layerzero.json').eids
}

export function buildMappings(
  networksKey: string,
  facetConfig: Record<string, unknown>,
  networks: Record<string, { chainId: number }>,
  eids: Record<string, number>
): IChainIdConfig[] {
  const supported = facetConfig[networksKey] as Record<string, unknown>
  if (!supported)
    throw new Error(`missing "${networksKey}" key in facet config`)

  const mappings: IChainIdConfig[] = []
  for (const network of Object.keys(supported)) {
    const chainId = networks[network]?.chainId
    if (chainId === undefined)
      throw new Error(`network "${network}" not found in networks.json`)
    const lzEid = eids[String(chainId)]
    if (lzEid !== undefined) mappings.push({ chainId, lzEid })
  }
  // deterministic order so the generated array is diff-stable
  return mappings.sort((a, b) => a.chainId - b.chainId)
}

function main(): void {
  const check = process.argv.includes('--check')
  const eids = readJson<{ eids: Record<string, number> }>('layerzero.json').eids
  const networks =
    readJson<Record<string, { chainId: number }>>('networks.json')

  let drift = false
  for (const { file, networksKey } of CONSUMERS) {
    const facetConfig = readJson<Record<string, unknown>>(file)
    const expected = buildMappings(networksKey, facetConfig, networks, eids)
    const current = JSON.stringify(facetConfig.mappings ?? null)

    if (current === JSON.stringify(expected)) continue

    if (check) {
      drift = true
      console.error(
        `${file}: mappings out of sync with layerzero.json — run \`bunx tsx tasks/syncLayerZeroEids.ts\``
      )
      continue
    }

    facetConfig.mappings = expected
    fs.writeFileSync(
      path.join(CONFIG, file),
      `${JSON.stringify(facetConfig, null, 2)}\n`
    )
    console.info(`${file}: wrote ${expected.length} mappings`)
  }

  if (check && drift) process.exit(1)
  if (check) console.info('layerzero eid mappings in sync')
}

if (import.meta.main) main()
