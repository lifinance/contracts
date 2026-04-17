/**
 * Hexagate address imports
 * ------------------------
 * Instead of entering contract addresses one-by-one in Hexagate, you can import CSV
 * files. Each row supplies a chain id, an address, and a comma-separated list of tags;
 * Hexagate applies those tags to the imported addresses automatically. This script
 * generates those CSVs from this repo’s deployment files so tags and addresses stay
 * aligned with `deployments/*.json`, `deployments/*.diamond.json`, and
 * `config/networks.json`.
 *
 * How to run (from the contracts repo root):
 *
 *   bunx tsx ./script/tasks/generateHexagateImportCsv.ts --networks <name1,name2,...>
 *
 * Options:
 *
 *   --networks <csv>     Required. Comma-separated network keys as in `networks.json`
 *                        (e.g. `worldchain,xlayer,tron,megaeth`).
 *
 *   --peripheries        Include periphery addresses from each network’s
 *                        `deployments/<network>.diamond.json` → `LiFiDiamond.Periphery`.
 *
 *   --safes              Include each network’s `safeAddress` from `config/networks.json`
 *                        (tag `SAFE`).
 *
 *   --diamonds           Include `LiFiDiamond` from `deployments/<network>.json`
 *                        (tag `diamond`).
 *
 *   --timelock-controllers
 *                        Include `LiFiTimelockController` from `deployments/<network>.json`
 *                        (tags `LiFiTimelockController`, `PERIPHERY`).
 *
 *   If you omit all four category flags above, every category is included. If you pass
 *   any of them, only the categories you pass are included.
 *
 *   --output-dir <dir>  Where to write CSVs (default: `deployments/hexagate-csv`
 *                        under the repo root).
 *
 *   --prefix <name>     Base name for files (default: `hexagate-import-address`).
 *                        Outputs are `<prefix>-0001.csv`, `<prefix>-0002.csv`, …
 *
 * Why multiple small CSV files?
 * -----------------------------
 * Hexagate’s importer has problems when a single CSV contains too many rows (imports
 * or conversions can fail or behave incorrectly). To avoid that, this script splits
 * output into several files with at most MAX_ROWS_PER_FILE data rows each (plus the
 * header row), so each file stays small enough for Hexagate to process reliably.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../..')

/** Data rows per file (excluding header). Kept small because Hexagate struggles with larger CSVs. */
const MAX_ROWS_PER_FILE = 10

const CATEGORY_FLAGS = [
  'peripheries',
  'safes',
  'diamonds',
  'timelock-controllers',
] as const

type Category = (typeof CATEGORY_FLAGS)[number]

interface INetworksJsonEntry {
  chainId?: number
  safeAddress?: string
  name?: string
}

type NetworksJson = Record<string, INetworksJsonEntry>

interface IDiamondFile {
  LiFiDiamond?: {
    Periphery?: Record<string, string>
  }
}

type DeploymentFlat = Record<string, string>

function parseArgs(argv: string[]): {
  networks: string[]
  outputDir: string
  filePrefix: string
  categories: Record<Category, boolean>
} {
  const out: {
    networks?: string
    outputDir: string
    filePrefix: string
    categories: Partial<Record<Category, boolean>>
  } = {
    outputDir: join(REPO_ROOT, 'deployments', 'hexagate-csv'),
    filePrefix: 'hexagate-import-address',
    categories: {},
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === undefined) {
      continue
    }
    if (a === '--networks') {
      const v = argv[++i]
      if (v) {
        out.networks = v
      }
      continue
    }
    if (a.startsWith('--networks=')) {
      out.networks = a.slice('--networks='.length)
      continue
    }
    if (a === '--output-dir') {
      const v = argv[++i]
      if (v) {
        out.outputDir = v
      }
      continue
    }
    if (a.startsWith('--output-dir=')) {
      out.outputDir = a.slice('--output-dir='.length)
      continue
    }
    if (a === '--prefix') {
      const v = argv[++i]
      if (v) {
        out.filePrefix = v
      }
      continue
    }
    if (a.startsWith('--prefix=')) {
      out.filePrefix = a.slice('--prefix='.length)
      continue
    }
    for (const c of CATEGORY_FLAGS) {
      if (a === `--${c}`) {
        out.categories[c] = true
        break
      }
    }
  }

  if (!out.networks?.trim()) {
    console.error(
      'Usage: bun script/tasks/generateHexagateImportCsv.ts --networks <name1,name2,...> [--output-dir DIR] [--prefix NAME]'
    )
    console.error(
      'Optional category flags (if none are passed, all are included): --peripheries --safes --diamonds --timelock-controllers'
    )
    process.exit(1)
  }

  const networks = out.networks
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const explicitAny = CATEGORY_FLAGS.some((c) => out.categories[c] === true)
  const categories = {} as Record<Category, boolean>
  for (const c of CATEGORY_FLAGS) {
    categories[c] = explicitAny ? out.categories[c] === true : true
  }

  return {
    networks,
    outputDir: out.outputDir,
    filePrefix: out.filePrefix,
    categories,
  }
}

function isNonEmptyAddress(addr: string | undefined): addr is string {
  return typeof addr === 'string' && addr.trim().length > 0
}

/** Periphery rows: tag with contract name only for Across receivers; all others get PERIPHERY only. */
function peripheryTags(contractName: string): string[] {
  if (contractName === 'ReceiverAcrossV4') {
    return ['PERIPHERY', 'ReceiverAcrossV4']
  }
  if (contractName === 'ReceiverAcrossV3') {
    return ['PERIPHERY', 'ReceiverAcrossV3']
  }
  return ['PERIPHERY']
}

function sortTags(tags: Iterable<string>): string {
  return [...new Set(tags)].sort((a, b) => a.localeCompare(b)).join(',')
}

function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

async function main(): Promise<void> {
  const { networks, outputDir, filePrefix, categories } = parseArgs(
    process.argv.slice(2)
  )

  const [networksRaw, ...diamondReads] = await Promise.all([
    readFile(join(REPO_ROOT, 'config', 'networks.json'), 'utf8'),
    ...networks.map((n) =>
      readFile(
        join(REPO_ROOT, 'deployments', `${n}.diamond.json`),
        'utf8'
      ).catch(() => null as string | null)
    ),
  ])

  const networksJson = JSON.parse(networksRaw) as NetworksJson

  interface IHexagateCsvRow {
    chainId: string
    address: string
    tags: string
  }
  const rowMap = new Map<string, Set<string>>()

  function addRow(
    chainId: number | string,
    address: string,
    tagList: string[]
  ): void {
    const cid = String(chainId)
    const key = `${cid}:${address}`
    let set = rowMap.get(key)
    if (!set) {
      set = new Set<string>()
      rowMap.set(key, set)
    }
    for (const t of tagList) {
      set.add(t)
    }
  }

  for (let ni = 0; ni < networks.length; ni++) {
    const network = networks[ni]
    if (network === undefined) {
      continue
    }
    const netCfg = networksJson[network]
    if (!netCfg?.chainId) {
      console.warn(`Skipping unknown network or missing chainId: ${network}`)
      continue
    }
    const chainId = netCfg.chainId

    const flatPath = join(REPO_ROOT, 'deployments', `${network}.json`)
    let flat: DeploymentFlat = {}
    try {
      flat = JSON.parse(await readFile(flatPath, 'utf8')) as DeploymentFlat
    } catch {
      console.warn(
        `Missing or invalid deployments/${network}.json — skipping deployment-based rows`
      )
    }

    const diamondJson = diamondReads[ni]
    let diamond: IDiamondFile = {}
    if (diamondJson) {
      try {
        diamond = JSON.parse(diamondJson) as IDiamondFile
      } catch {
        console.warn(`Invalid JSON in deployments/${network}.diamond.json`)
      }
    } else {
      console.warn(
        `Missing deployments/${network}.diamond.json — skipping periphery rows`
      )
    }

    if (categories['timelock-controllers']) {
      const addr = flat.LiFiTimelockController
      if (isNonEmptyAddress(addr)) {
        addRow(chainId, addr, ['LiFiTimelockController', 'PERIPHERY'])
      }
    }

    if (categories.diamonds) {
      const addr = flat.LiFiDiamond
      if (isNonEmptyAddress(addr)) {
        addRow(chainId, addr, ['diamond'])
      }
    }

    if (categories.safes) {
      const addr = netCfg.safeAddress
      if (isNonEmptyAddress(addr)) {
        addRow(chainId, addr, ['SAFE'])
      }
    }

    if (categories.peripheries) {
      const periphery = diamond.LiFiDiamond?.Periphery
      if (periphery) {
        for (const [name, addr] of Object.entries(periphery)) {
          if (!isNonEmptyAddress(addr)) {
            continue
          }
          addRow(chainId, addr, peripheryTags(name))
        }
      }
    }
  }

  const rows: IHexagateCsvRow[] = []
  for (const [key, tagSet] of rowMap) {
    const sep = key.indexOf(':')
    const chainId = key.slice(0, sep)
    const address = key.slice(sep + 1)
    rows.push({
      chainId,
      address,
      tags: sortTags(tagSet),
    })
  }

  rows.sort((a, b) => {
    const c = a.chainId.localeCompare(b.chainId, undefined, { numeric: true })
    if (c !== 0) {
      return c
    }
    return a.address.localeCompare(b.address)
  })

  if (rows.length === 0) {
    console.error(
      'No rows generated. Check networks, flags, and deployment files.'
    )
    process.exit(1)
  }

  await mkdir(outputDir, { recursive: true })

  const header = '"chainId","address","tags"'
  let part = 0
  for (let i = 0; i < rows.length; i += MAX_ROWS_PER_FILE) {
    const chunk = rows.slice(i, i + MAX_ROWS_PER_FILE)
    part += 1
    const fileName = `${filePrefix}-${String(part).padStart(4, '0')}.csv`
    const filePath = join(outputDir, fileName)
    const lines = [
      header,
      ...chunk.map(
        (r) =>
          `${csvEscape(r.chainId)},${csvEscape(r.address)},${csvEscape(r.tags)}`
      ),
    ]
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8')
    console.log(`Wrote ${filePath} (${chunk.length} data rows)`)
  }

  console.log(`Done: ${rows.length} total rows in ${part} file(s).`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
