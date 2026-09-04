import fs from 'fs'
import path from 'path'

import { defineCommand, runMain } from 'citty'

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

interface INetworkConfig {
  chainId: number
  status?: string
}

interface IClearSigningProposal {
  $count?: number
  $note?: string
  formats: Record<string, Json>
}

interface ILedgerDisplay {
  formats?: Record<string, Json>
  // ERC-7730 also allows `definitions`, `screens`, etc. — preserve via [k: string]
  [k: string]: unknown
}

interface ILedgerRegistryFile {
  $schema?: string
  context?: {
    $id?: string
    contract?: {
      deployments?: Array<{ chainId: number; address: string }>
      // [Deprecated] Present in older registry files; stripped on every sync.
      abi?: unknown[]
    }
  }
  metadata?: Json
  display?: ILedgerDisplay
  // allow extra keys
  [k: string]: unknown
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T
}

// All path args must stay inside the working directory (the repo checkout in
// local runs; the workspace containing the ledger-registry clone in CI).
function resolveWithinCwd(inputPath: string): string {
  const base = process.cwd()
  const absPath = path.resolve(base, inputPath)
  const relativePath = path.relative(base, absPath)
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath))
    throw new Error(`Path escapes the working directory: ${inputPath}`)
  return absPath
}

function writePrettyJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

// An ERC-7730 format with an explicitly empty `fields` renders only a title (no
// amount, receiver, or destination) and the registry rejects it. Earlier syncs
// pushed such entries for the `*Packed` / `*Min` bridge entry-points: `*Packed`
// declares no ABI parameters at all, `*Min` a packed tuple the templates do not
// decode, so neither can carry a useful field. The proposal no longer emits them
// (tasks/buildClearSigningProposal.ts), so the merge below would otherwise
// preserve that residue forever.
//
// The test is deliberately narrow on both axes. Only `*Packed` / `*Min` keys
// qualify: every other key is either ours (replaced from the proposal) or
// authored by the EF working group, and deleting the latter would silently
// propose removing their work. And `fields` must be present and empty: an entry
// that omits `fields` may legally inherit them from a file the registry pulls in
// via the top-level `includes` key, so it renders fine and is not ours to drop.
function isResidualTitleOnlyEntry(formatKey: string, entry: unknown): boolean {
  const parenIndex = formatKey.indexOf('(')
  const functionName =
    parenIndex === -1 ? formatKey : formatKey.slice(0, parenIndex)
  if (!/(Packed|Min)$/u.test(functionName)) return false
  if (!isObject(entry)) return false
  return Array.isArray(entry.fields) && entry.fields.length === 0
}

// Merges `display.formats` entries from the local proposal into the registry's
// existing display block.
//
// Rules:
//  - Selectors present in the proposal: REPLACE in the registry. The proposal
//    is the source of truth for our diamond's UX (CI-validated current).
//  - Selectors present in the registry but not in the proposal: PRESERVE.
//    These may be registry-only entries the EF working group adds, or stale
//    entries for selectors we deprecated but older deployments still expose.
//    The one exception is our own title-only `*Packed` / `*Min` residue — see
//    `isResidualTitleOnlyEntry`.
//  - Other `display.*` keys (definitions, screens, etc.): PRESERVE verbatim.
//
// Returns the next `display` object. Pass `proposalFilePath = null` to skip
// merging (preserves the registry's display untouched).
function mergeDisplayFormats(
  existing: ILedgerDisplay | undefined,
  proposalFilePath: string | null
): ILedgerDisplay {
  const next: ILedgerDisplay = { ...(existing ?? {}) }
  if (!proposalFilePath) return next

  const absPath = resolveWithinCwd(proposalFilePath)
  if (!fs.existsSync(absPath)) {
    console.warn(
      `Proposal file not found at ${absPath}; preserving display.* unchanged.`
    )
    return next
  }
  const proposal = readJsonFile<IClearSigningProposal>(absPath)
  if (!proposal.formats || typeof proposal.formats !== 'object') {
    console.warn(
      `Proposal at ${absPath} has no .formats object; preserving display.* unchanged.`
    )
    return next
  }

  const existingFormats: Record<string, Json> =
    (existing?.formats as Record<string, Json> | undefined) ?? {}
  const nextFormats: Record<string, Json> = { ...existingFormats }

  let replaced = 0
  let added = 0
  for (const [sig, entry] of Object.entries(proposal.formats)) {
    if (sig in nextFormats) replaced++
    else added++
    nextFormats[sig] = entry as Json
  }
  const dropped: string[] = []
  for (const [sig, entry] of Object.entries(nextFormats))
    if (isResidualTitleOnlyEntry(sig, entry)) {
      delete nextFormats[sig]
      dropped.push(sig)
    }

  const preserved = Object.keys(nextFormats).filter(
    (k) => !(k in proposal.formats)
  ).length

  console.log(
    `display.formats merge: +${added} added, ~${replaced} replaced, =${preserved} preserved (unowned), -${dropped.length} dropped (title-only Packed/Min residue)`
  )
  for (const sig of dropped) console.log(`  dropped: ${sig}`)
  next.formats = nextFormats
  return next
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

    // Catches networks marked inactive whose deployment files are still present
    if (cfg.status && cfg.status !== 'active') continue

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
      'Updates ERC-7730 registry JSON for LiFiDiamond: regenerates context.contract.deployments from this repo, strips the deprecated context.contract.abi, and merges display.formats from config/clearSigningProposal.json (registry entries we own → replaced; entries we do not own → preserved). metadata + other display keys are preserved verbatim.',
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
    proposalFilePath: {
      type: 'string',
      description:
        "Path to the clear-signing display.formats proposal JSON (generated by tasks/buildClearSigningProposal.ts). Defaults to ./config/clearSigningProposal.json. Entries from this file replace same-selector entries in the registry's display.formats; other display entries are preserved.",
      default: './config/clearSigningProposal.json',
    },
    skipDisplayMerge: {
      type: 'boolean',
      description:
        'Do not merge display.formats from the proposal file. Useful for emergency runs when the proposal is known stale or the gate is being debugged.',
      default: false,
    },
    printDiff: {
      type: 'boolean',
      description:
        'Print the deployments diff between Ledger JSON and local repo-derived values before writing.',
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
            readJsonFile<unknown>(resolveWithinCwd(filePath))
          )
        })()

    const nextDeployments = args.skipDeployments
      ? undefined
      : buildDeploymentsFromRepo(
          resolveWithinCwd(args.deploymentsDir),
          resolveWithinCwd(args.networksJson)
        )

    if (args.printDiff && nextDeployments) {
      const d = diffLedgerVsLocalDeployments({
        ledger,
        localDeployments: nextDeployments,
      })
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

    if (args.diffOnly) return

    const context = ledger.context ?? {}
    const contract = context.contract ?? {}

    // Strip the deprecated context.contract.abi. Since the v2 schema the registry
    // infers the ABI + selectors from the display.formats keys (they carry full
    // signatures), and the maintainer asked us to stop shipping it (EXSC-894).
    // The generator merges into the fetched registry file, so an existing abi key
    // must be deleted explicitly — leaving it unset would preserve the old block.
    const nextContract = { ...contract }
    delete nextContract.abi
    if (nextDeployments) nextContract.deployments = nextDeployments

    // Merge `display.formats` from our committed proposal into the registry's
    // existing `display`. Two-way contract:
    //  - selectors the proposal owns (any key in proposal.formats): we overwrite,
    //    because the contracts repo is the source of truth for our diamond's UX.
    //    The CI gate in `verifyClearSigning.yml` guarantees this proposal is
    //    current vs the on-chain diamond at PR-merge time.
    //  - selectors the proposal doesn't own (registry-only entries — e.g. common-
    //    bridge.json includes, EF working-group additions): preserve unchanged.
    //  - selectors removed from our diamond (in registry but not in proposal):
    //    preserve. Some older deployments may still expose them; dropping the
    //    entry would break clear-signing for those signers. Dead entries are
    //    a cheap cost. The exception is title-only `*Packed` / `*Min` residue we
    //    pushed ourselves, which the registry rejects (`isResidualTitleOnlyEntry`).
    //
    // Other `display.*` keys (definitions, screens, etc.) are preserved verbatim.
    const nextDisplay = mergeDisplayFormats(
      ledger.display,
      args.skipDisplayMerge ? null : (args.proposalFilePath as string)
    )

    const nextLedger: ILedgerRegistryFile = {
      $schema: ledger.$schema,
      context: {
        ...context,
        contract: nextContract,
      },
      metadata: ledger.metadata,
      display: nextDisplay,
    }

    // Preserve any extra top-level keys Ledger may add later
    for (const [k, v] of Object.entries(ledger)) {
      if (k in nextLedger) continue
      nextLedger[k] = v
    }

    const outputPath = args.outputFilePath
      ? resolveWithinCwd(args.outputFilePath)
      : args.ledgerFilePath
      ? resolveWithinCwd(args.ledgerFilePath)
      : undefined

    if (!outputPath) {
      throw new Error(
        'No output path available. Provide --ledgerFilePath (in-place) or --outputFilePath.'
      )
    }

    writePrettyJson(outputPath, nextLedger)
    console.log(`Updated ${outputPath}`)
    if (!args.skipDeployments)
      console.log(`- Deployments: ${nextDeployments?.length ?? 0}`)
  },
})

runMain(main)
