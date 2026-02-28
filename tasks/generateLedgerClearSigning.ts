import fs from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'
import { keccak256, toBytes } from 'viem'

type Json = Record<string, unknown>

function installEpipeHandler(): void {
  const onError = (err: unknown) => {
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: string }).code === 'EPIPE'
    ) {
      // Consumer closed the pipe (e.g. `| head`). Exit quietly.
      process.exit(0)
    }
  }
  process.stdout.on('error', onError)
}

interface IAbiParam {
  name?: string
  type: string
  internalType?: string
  components?: IAbiParam[]
  indexed?: boolean
}

interface IAbiItemBase {
  type: string
  name?: string
}

interface IAbiFunction extends IAbiItemBase {
  type: 'function'
  name: string
  inputs: IAbiParam[]
  outputs?: IAbiParam[]
  stateMutability?: string
}

interface IAbiEvent extends IAbiItemBase {
  type: 'event'
  name: string
  inputs: IAbiParam[]
  anonymous?: boolean
}

interface IAbiError extends IAbiItemBase {
  type: 'error'
  name: string
  inputs?: IAbiParam[]
}

type AbiItem = IAbiFunction | IAbiEvent | IAbiError | IAbiItemBase

interface IFoundryArtifact {
  abi: AbiItem[]
}

interface INetworkConfig {
  chainId: number
  status?: string
  type?: string
}

interface ILedgerRegistryFile {
  $schema?: string
  context?: {
    $id?: string
    contract?: {
      deployments?: Array<{ chainId: number; address: string }>
      abi?: AbiItem[]
    }
  }
  metadata?: Json
  display?: Json
  // allow extra keys
  [k: string]: unknown
}

function canonicalType(param: IAbiParam): string {
  if (!param.type.startsWith('tuple')) return param.type
  const suffix = param.type.slice('tuple'.length) // "", "[]", "[2]" etc
  if (!param.components || param.components.length === 0) return `()${suffix}`
  const inner = param.components.map(canonicalType).join(',')
  return `(${inner})${suffix}`
}

function functionSignature(fn: IAbiFunction): string {
  const inputs = fn.inputs?.map(canonicalType).join(',') ?? ''
  return `${fn.name}(${inputs})`
}

function selectorFromSignature(sig: string): string {
  return keccak256(toBytes(sig)).slice(0, 10)
}

function eventSignature(ev: IAbiEvent): string {
  const inputs =
    ev.inputs
      ?.map((p) => `${p.indexed ? 'indexed:' : ''}${canonicalType(p)}`)
      .join(',') ?? ''
  return `${ev.name}(${inputs})`
}

function errorSignature(er: IAbiError): string {
  const inputs = er.inputs?.map(canonicalType).join(',') ?? ''
  return `${er.name}(${inputs})`
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

function writePrettyJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

function listFacetArtifacts(facetsDir: string, outDir: string): string[] {
  const facetFiles = fs
    .readdirSync(facetsDir)
    .filter((f) => f.endsWith('.sol'))
    .sort((a, b) => a.localeCompare(b))

  return facetFiles.map((file) => {
    const jsonFile = file.replace(/\.sol$/u, '.json')
    return path.resolve(outDir, file, jsonFile)
  })
}

function buildDiamondAbiFromFacets(
  facetsDir: string,
  outDir: string
): AbiItem[] {
  const artifactPaths = listFacetArtifacts(facetsDir, outDir)

  const seen = new Set<string>()
  const collected: AbiItem[] = []

  for (const artifactPath of artifactPaths) {
    if (!fs.existsSync(artifactPath)) {
      throw new Error(
        `Missing Foundry artifact at ${artifactPath}. Did you run "forge build" first?`
      )
    }

    const artifact = readJsonFile<IFoundryArtifact>(artifactPath)
    for (const item of artifact.abi ?? []) {
      // Skip constructors (not callable via diamond)
      if (item.type === 'constructor') continue

      let key: string
      if (item.type === 'function')
        key = `fn:${functionSignature(item as IAbiFunction)}`
      else if (item.type === 'event')
        key = `ev:${eventSignature(item as IAbiEvent)}`
      else if (item.type === 'error')
        key = `er:${errorSignature(item as IAbiError)}`
      else key = `misc:${item.type}:${item.name ?? ''}`

      if (seen.has(key)) continue
      seen.add(key)
      collected.push(item)
    }
  }

  const orderType = (t: string): number => {
    if (t === 'function') return 0
    if (t === 'event') return 1
    if (t === 'error') return 2
    if (t === 'receive') return 3
    if (t === 'fallback') return 4
    return 99
  }

  collected.sort((a, b) => {
    const ta = orderType(a.type)
    const tb = orderType(b.type)
    if (ta !== tb) return ta - tb

    const na = a.name ?? ''
    const nb = b.name ?? ''
    if (na !== nb) return na.localeCompare(nb)

    if (a.type === 'function' && b.type === 'function')
      return functionSignature(a as IAbiFunction).localeCompare(
        functionSignature(b as IAbiFunction)
      )
    if (a.type === 'event' && b.type === 'event')
      return eventSignature(a as IAbiEvent).localeCompare(
        eventSignature(b as IAbiEvent)
      )
    if (a.type === 'error' && b.type === 'error')
      return errorSignature(a as IAbiError).localeCompare(
        errorSignature(b as IAbiError)
      )

    return 0
  })

  return collected
}

function buildDeploymentsFromRepo(
  deploymentsDir: string,
  networksJsonPath: string
): Array<{ chainId: number; address: string }> {
  const networks =
    readJsonFile<Record<string, INetworkConfig>>(networksJsonPath)

  const entries: Array<{ chainId: number; address: string }> = []
  const files = fs
    .readdirSync(deploymentsDir)
    .filter((f) => f.endsWith('.json'))

  for (const file of files) {
    const networkName = file.replace(/\.json$/u, '')
    const cfg = networks[networkName]
    if (!cfg) continue

    // Ledger file targets production deployments; ignore testnets/inactive networks
    if (cfg.status && cfg.status !== 'active') continue
    if (cfg.type && cfg.type !== 'mainnet') continue

    const deploymentPath = path.resolve(deploymentsDir, file)
    const data = readJsonFile<Record<string, unknown>>(deploymentPath)

    const diamondAddr = data['LiFiDiamond']
    if (typeof diamondAddr !== 'string') continue
    if (!diamondAddr.startsWith('0x') || diamondAddr.length !== 42) continue

    entries.push({ chainId: cfg.chainId, address: diamondAddr })
  }

  // de-dupe by chainId (prefer last-read file in case of duplicates)
  const byChainId = new Map<number, string>()
  for (const e of entries) byChainId.set(e.chainId, e.address)

  return Array.from(byChainId.entries())
    .map(([chainId, address]) => ({ chainId, address }))
    .sort((a, b) => a.chainId - b.chainId)
}

function normalizeLedgerFile(input: unknown): ILedgerRegistryFile {
  if (!isObject(input))
    throw new Error('Ledger registry JSON must be an object')
  return input as ILedgerRegistryFile
}

function normalizeAddress(address: string): string {
  return address.toLowerCase()
}

function isAbiFunction(item: AbiItem): item is IAbiFunction {
  return item.type === 'function'
}

function diffLedgerVsLocalFunctions(params: {
  ledger: ILedgerRegistryFile
  localAbi: AbiItem[]
}): {
  localCount: number
  ledgerCount: number
  missingInLedger: Array<{ sig: string; selector: string }>
  extraInLedger: Array<{ sig: string; selector: string }>
} {
  const ledgerAbi = params.ledger.context?.contract?.abi ?? []
  const ledgerFns = ledgerAbi.filter(isAbiFunction)
  const localFns = params.localAbi.filter(isAbiFunction)

  const localBySig = new Map<string, string>()
  for (const fn of localFns) {
    const sig = functionSignature(fn)
    localBySig.set(sig, selectorFromSignature(sig))
  }

  const ledgerBySig = new Map<string, string>()
  for (const fn of ledgerFns) {
    const sig = functionSignature(fn)
    ledgerBySig.set(sig, selectorFromSignature(sig))
  }

  const missingInLedger: Array<{ sig: string; selector: string }> = []
  for (const [sig, selector] of localBySig.entries()) {
    if (!ledgerBySig.has(sig)) missingInLedger.push({ sig, selector })
  }

  const extraInLedger: Array<{ sig: string; selector: string }> = []
  for (const [sig, selector] of ledgerBySig.entries()) {
    if (!localBySig.has(sig)) extraInLedger.push({ sig, selector })
  }

  missingInLedger.sort((a, b) => a.sig.localeCompare(b.sig))
  extraInLedger.sort((a, b) => a.sig.localeCompare(b.sig))

  return {
    localCount: localFns.length,
    ledgerCount: ledgerFns.length,
    missingInLedger,
    extraInLedger,
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

function safeLog(line: string): void {
  try {
    // Avoid crashing when stdout is closed (e.g. piped to `head`)
    process.stdout.write(`${line}\n`)
  } catch {
    // noop
  }
}

function safeLogEmptyLine(): void {
  safeLog('')
}

function diffLedgerVsLocalDeployments(params: {
  ledger: ILedgerRegistryFile
  localDeployments: Array<{ chainId: number; address: string }>
}): {
  ledgerCount: number
  localCount: number
  added: Array<{ chainId: number; address: string }>
  removed: Array<{ chainId: number; address: string }>
  changed: Array<{ chainId: number; from: string; to: string }>
} {
  const ledgerDeployments = params.ledger.context?.contract?.deployments ?? []

  const ledgerByChainId = new Map<number, string>()
  for (const d of ledgerDeployments)
    ledgerByChainId.set(d.chainId, normalizeAddress(d.address))

  const localByChainId = new Map<number, string>()
  for (const d of params.localDeployments)
    localByChainId.set(d.chainId, normalizeAddress(d.address))

  const added: Array<{ chainId: number; address: string }> = []
  const removed: Array<{ chainId: number; address: string }> = []
  const changed: Array<{ chainId: number; from: string; to: string }> = []

  for (const [chainId, addr] of localByChainId.entries()) {
    const ledgerAddr = ledgerByChainId.get(chainId)
    if (!ledgerAddr) added.push({ chainId, address: addr })
    else if (ledgerAddr !== addr)
      changed.push({ chainId, from: ledgerAddr, to: addr })
  }

  for (const [chainId, addr] of ledgerByChainId.entries()) {
    const localAddr = localByChainId.get(chainId)
    if (!localAddr) removed.push({ chainId, address: addr })
  }

  added.sort((a, b) => a.chainId - b.chainId)
  removed.sort((a, b) => a.chainId - b.chainId)
  changed.sort((a, b) => a.chainId - b.chainId)

  return {
    ledgerCount: ledgerDeployments.length,
    localCount: params.localDeployments.length,
    added,
    removed,
    changed,
  }
}

const main = defineCommand({
  meta: {
    name: 'generate-ledger-clear-signing',
    description:
      'Updates Ledger ERC-7730 registry JSON for LiFiDiamond (deployments + ABI), preserving display/metadata.',
  },
  args: {
    ledgerFilePath: {
      type: 'string',
      description:
        'Path to Ledger JSON file (e.g. registry/lifi/calldata-LIFIDiamond.json) to update in-place.',
      required: false,
    },
    ledgerUrl: {
      type: 'string',
      description:
        'Optional: fetch Ledger JSON from URL (for compare-only or to write to outputFilePath).',
      required: false,
    },
    outputFilePath: {
      type: 'string',
      description:
        'Optional: write output to this file (defaults to ledgerFilePath for in-place updates).',
      required: false,
    },
    facetsDir: {
      type: 'string',
      description: 'Facets directory to aggregate ABI from',
      default: './src/Facets',
    },
    foundryOutDir: {
      type: 'string',
      description: 'Foundry out directory containing compiled artifacts',
      default: './out',
    },
    deploymentsDir: {
      type: 'string',
      description:
        'Deployments directory containing per-network JSON deployment files',
      default: './deployments',
    },
    networksJson: {
      type: 'string',
      description: 'Path to config/networks.json',
      default: './config/networks.json',
    },
    skipDeployments: {
      type: 'boolean',
      description: 'Do not modify context.contract.deployments',
      default: false,
    },
    skipAbi: {
      type: 'boolean',
      description: 'Do not modify context.contract.abi',
      default: false,
    },
    printDiff: {
      type: 'boolean',
      description:
        'Print ABI + deployments diffs between Ledger JSON and local repo-derived values before writing.',
      default: false,
    },
    diffOnly: {
      type: 'boolean',
      description:
        'Only compute/print diffs (and/or derived counts); do not write any output file.',
      default: false,
    },
  },
  async run({ args }) {
    installEpipeHandler()

    if (!args.ledgerFilePath && !args.ledgerUrl) {
      throw new Error('Provide either --ledgerFilePath or --ledgerUrl')
    }

    const ledger = args.ledgerUrl
      ? normalizeLedgerFile(await fetchJson<unknown>(args.ledgerUrl))
      : (() => {
          const filePath = args.ledgerFilePath
          if (!filePath) throw new Error('ledgerFilePath missing')
          return normalizeLedgerFile(
            readJsonFile<unknown>(path.resolve(process.cwd(), filePath))
          )
        })()

    const nextAbi = args.skipAbi
      ? undefined
      : buildDiamondAbiFromFacets(
          path.resolve(process.cwd(), args.facetsDir),
          path.resolve(process.cwd(), args.foundryOutDir)
        )

    const nextDeployments = args.skipDeployments
      ? undefined
      : buildDeploymentsFromRepo(
          path.resolve(process.cwd(), args.deploymentsDir),
          path.resolve(process.cwd(), args.networksJson)
        )

    if (args.printDiff) {
      if (nextAbi) {
        const diff = diffLedgerVsLocalFunctions({ ledger, localAbi: nextAbi })
        safeLog(`Local functions:  ${diff.localCount}`)
        safeLog(`Ledger functions: ${diff.ledgerCount}`)
        safeLog(`Missing in Ledger: ${diff.missingInLedger.length}`)
        safeLog(`Extra in Ledger:   ${diff.extraInLedger.length}`)

        if (diff.missingInLedger.length) {
          safeLogEmptyLine()
          safeLog('--- Missing in Ledger (local ABI has, Ledger does not) ---')
          for (const { sig, selector } of diff.missingInLedger)
            safeLog(`${selector} ${sig}`)
        }
        if (diff.extraInLedger.length) {
          safeLogEmptyLine()
          safeLog('--- Extra in Ledger (Ledger has, local ABI does not) ---')
          for (const { sig, selector } of diff.extraInLedger)
            safeLog(`${selector} ${sig}`)
        }
      }

      if (nextDeployments) {
        const d = diffLedgerVsLocalDeployments({
          ledger,
          localDeployments: nextDeployments,
        })
        safeLogEmptyLine()
        safeLog(`Ledger deployments: ${d.ledgerCount}`)
        safeLog(`Local deployments:  ${d.localCount}`)
        safeLog(`Deployments added:  ${d.added.length}`)
        safeLog(`Deployments removed: ${d.removed.length}`)
        safeLog(`Deployments changed: ${d.changed.length}`)

        if (d.added.length) {
          safeLogEmptyLine()
          safeLog('--- Deployments added (local has, Ledger does not) ---')
          for (const x of d.added) safeLog(`+ ${x.chainId} ${x.address}`)
        }
        if (d.removed.length) {
          safeLogEmptyLine()
          safeLog('--- Deployments removed (Ledger has, local does not) ---')
          for (const x of d.removed) safeLog(`- ${x.chainId} ${x.address}`)
        }
        if (d.changed.length) {
          safeLogEmptyLine()
          safeLog('--- Deployments changed (same chainId, address differs) ---')
          for (const x of d.changed)
            safeLog(`~ ${x.chainId} ${x.from} -> ${x.to}`)
        }
      }
    }

    if (args.diffOnly) return

    const context = ledger.context ?? {}
    const contract = context.contract ?? {}

    const nextContract = {
      ...contract,
      ...(nextDeployments ? { deployments: nextDeployments } : {}),
      ...(nextAbi ? { abi: nextAbi } : {}),
    }

    const nextLedger: ILedgerRegistryFile = {
      $schema: ledger.$schema,
      context: {
        ...context,
        contract: nextContract,
      },
      metadata: ledger.metadata,
      display: ledger.display,
    }

    // Preserve any extra top-level keys Ledger may add later
    for (const [k, v] of Object.entries(ledger)) {
      if (k in nextLedger) continue
      nextLedger[k] = v
    }

    const outputPath = args.outputFilePath
      ? path.resolve(process.cwd(), args.outputFilePath)
      : args.ledgerFilePath
      ? path.resolve(process.cwd(), args.ledgerFilePath)
      : undefined

    if (!outputPath) {
      throw new Error(
        'No output path available. Provide --ledgerFilePath (in-place) or --outputFilePath.'
      )
    }

    writePrettyJson(outputPath, nextLedger)
    console.log(`Updated ${outputPath}`)
    if (!args.skipAbi) console.log(`- ABI entries: ${nextAbi?.length ?? 0}`)
    if (!args.skipDeployments)
      console.log(`- Deployments: ${nextDeployments?.length ?? 0}`)
  },
})

runMain(main)
