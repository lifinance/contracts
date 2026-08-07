/**
 * Local-first function-selector registry shared across Safe scripts.
 *
 * Resolves 4-byte selectors to function names/signatures from sources that
 * already live in the repo — diamond.json, config/clearSigningProposal.json,
 * config/whitelist.json and a short list of well-known signatures (Timelock,
 * Safe admin, ERC20) — so the signing UI does not pay an HTTP round trip for
 * selectors we ship ourselves. Selectors that are genuinely unknown locally
 * are resolved through the Sourcify 4byte API in a single batched request and
 * persisted to .cache/selector-signatures.json, so any given selector hits
 * the network at most once per machine.
 *
 * Keep this file dependency-light (fs/path/viem/consola only) so both
 * safe-utils and safe-decode-utils can import it without cycles.
 */

import * as fs from 'fs'
import * as path from 'path'

import { consola } from 'consola'
import {
  parseAbiItem,
  toFunctionSelector,
  toFunctionSignature,
  type AbiFunction,
} from 'viem'

import { fetchWithTimeout } from '../../utils/fetchWithTimeout'

export interface ISelectorInfo {
  name: string
  signature: string
  source: string
}

/**
 * Signatures the Safe scripts routinely encounter. Includes the LI.FI admin
 * functions the display code special-cases, so they resolve even on machines
 * without a generated diamond.json.
 */
const WELL_KNOWN_SIGNATURES: readonly string[] = [
  // LiFiDiamond admin
  'diamondCut((address,uint8,bytes4[])[],address,bytes)',
  'batchSetContractSelectorWhitelist(address[],bytes4[],bool)',
  'registerPeripheryContract(string,address)',
  // TimelockController
  'schedule(address,uint256,bytes,bytes32,bytes32,uint256)',
  'scheduleBatch(address[],uint256[],bytes[],bytes32,bytes32,uint256)',
  'execute(address,uint256,bytes,bytes32,bytes32)',
  'executeBatch(address[],uint256[],bytes[],bytes32,bytes32)',
  'cancel(bytes32)',
  'updateDelay(uint256)',
  // AccessControl
  'grantRole(bytes32,address)',
  'revokeRole(bytes32,address)',
  'renounceRole(bytes32,address)',
  // ERC20
  'transfer(address,uint256)',
  'approve(address,uint256)',
  'transferFrom(address,address,uint256)',
  // Safe owner/module management
  'addOwnerWithThreshold(address,uint256)',
  'removeOwner(address,address,uint256)',
  'swapOwner(address,address,address)',
  'changeThreshold(uint256)',
  'enableModule(address)',
  'disableModule(address,address)',
  'setGuard(address)',
  'setFallbackHandler(address)',
  // Ownership
  'transferOwnership(address)',
  'acceptOwnership()',
  'renounceOwnership()',
]

function normalizeSelector(selector: string): string {
  const lower = selector.toLowerCase()
  return lower.startsWith('0x') ? lower : `0x${lower}`
}

/**
 * True when `signature` actually hashes to `selector`. Guards the sources that
 * pair a selector with a signature textually (whitelist.json, the disk cache,
 * 4byte responses) rather than deriving the selector from the signature — so a
 * hand-edited typo or a poisoned cache degrades to "unknown selector" in the
 * signing UI instead of a wrong-but-plausible function name.
 */
function isVerifiedSelectorSignature(
  selector: string,
  signature: string
): boolean {
  try {
    return toFunctionSelector(signature) === normalizeSelector(selector)
  } catch {
    return false
  }
}

function nameFromSignature(signature: string): string {
  const parenIndex = signature.indexOf('(')
  return parenIndex === -1 ? signature : signature.slice(0, parenIndex)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setIfAbsent(
  map: Map<string, ISelectorInfo>,
  selector: string,
  info: ISelectorInfo
): void {
  const key = normalizeSelector(selector)
  if (!map.has(key)) map.set(key, info)
}

/**
 * Derives selector → info entries from clearSigningProposal.json `formats`
 * keys, which are human-readable signatures with named params/tuple fields
 * (ERC-7730 style). Unparseable keys are skipped.
 */
export function buildSelectorMapFromClearSigningFormats(
  formats: Record<string, unknown>
): Map<string, ISelectorInfo> {
  const map = new Map<string, ISelectorInfo>()
  for (const key of Object.keys(formats)) {
    try {
      const item = parseAbiItem(
        key.startsWith('function ') ? key : `function ${key}`
      ) as AbiFunction
      const canonical = toFunctionSignature(item)
      setIfAbsent(map, toFunctionSelector(item), {
        name: item.name,
        signature: canonical,
        source: 'clearSigningProposal.json',
      })
    } catch {
      continue
    }
  }
  return map
}

/**
 * Harvests every selector/signature pair stored in whitelist.json — both the
 * PERIPHERY per-network `selectors` arrays and the section-level per-contract
 * `functions` maps. Addresses are ignored: a signature is a global fact.
 */
export function buildSelectorMapFromWhitelist(
  whitelistJson: unknown
): Map<string, ISelectorInfo> {
  const map = new Map<string, ISelectorInfo>()
  if (!isRecord(whitelistJson)) return map

  const addEntry = (selector: unknown, signature: unknown): void => {
    if (typeof selector !== 'string' || typeof signature !== 'string') return
    if (!signature.trim()) return
    if (!isVerifiedSelectorSignature(selector, signature)) return
    setIfAbsent(map, selector, {
      name: nameFromSignature(signature),
      signature,
      source: 'whitelist.json',
    })
  }

  const periphery = whitelistJson['PERIPHERY']
  if (isRecord(periphery))
    for (const networkEntries of Object.values(periphery)) {
      if (!Array.isArray(networkEntries)) continue
      for (const entry of networkEntries) {
        if (!isRecord(entry) || !Array.isArray(entry.selectors)) continue
        for (const sel of entry.selectors)
          if (isRecord(sel)) addEntry(sel.selector, sel.signature)
      }
    }

  for (const sectionVal of Object.values(whitelistJson)) {
    if (!Array.isArray(sectionVal)) continue
    for (const item of sectionVal) {
      if (!isRecord(item) || !isRecord(item.contracts)) continue
      for (const contractsByNetwork of Object.values(item.contracts)) {
        if (!Array.isArray(contractsByNetwork)) continue
        for (const contract of contractsByNetwork) {
          if (!isRecord(contract) || !isRecord(contract.functions)) continue
          for (const [selector, signature] of Object.entries(
            contract.functions
          ))
            addEntry(selector, signature)
        }
      }
    }
  }
  return map
}

function buildSelectorMapFromDiamondJson(): Map<string, ISelectorInfo> {
  const map = new Map<string, ISelectorInfo>()
  try {
    const diamondPath = path.join(process.cwd(), 'diamond.json')
    if (!fs.existsSync(diamondPath)) return map
    const abiData = JSON.parse(fs.readFileSync(diamondPath, 'utf8'))
    if (!Array.isArray(abiData)) return map
    for (const abiItem of abiData) {
      if (abiItem?.type !== 'function') continue
      try {
        setIfAbsent(map, toFunctionSelector(abiItem), {
          name: abiItem.name,
          signature: toFunctionSignature(abiItem as AbiFunction),
          source: 'diamond.json',
        })
      } catch {
        continue
      }
    }
  } catch (error) {
    consola.debug(`selector-registry: diamond.json skipped: ${error}`)
  }
  return map
}

function readJsonConfig(relativePath: string): unknown {
  try {
    const filePath = path.join(process.cwd(), relativePath)
    if (!fs.existsSync(filePath)) return undefined
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    consola.debug(`selector-registry: ${relativePath} skipped: ${error}`)
    return undefined
  }
}

let localRegistryCache: Map<string, ISelectorInfo> | undefined

function getLocalRegistry(): Map<string, ISelectorInfo> {
  if (localRegistryCache) return localRegistryCache

  // Precedence: diamond.json (authoritative for diamond functions), then the
  // clear-signing proposal, then whitelist harvest, then well-known statics.
  const merged = buildSelectorMapFromDiamondJson()

  const clearSigning = readJsonConfig('config/clearSigningProposal.json')
  if (isRecord(clearSigning) && isRecord(clearSigning.formats))
    for (const [selector, info] of buildSelectorMapFromClearSigningFormats(
      clearSigning.formats
    ))
      setIfAbsent(merged, selector, info)

  for (const [selector, info] of buildSelectorMapFromWhitelist(
    readJsonConfig('config/whitelist.json')
  ))
    setIfAbsent(merged, selector, info)

  for (const signature of WELL_KNOWN_SIGNATURES)
    setIfAbsent(merged, toFunctionSelector(signature), {
      name: nameFromSignature(signature),
      signature,
      source: 'well-known',
    })

  localRegistryCache = merged
  return merged
}

/**
 * Looks a selector up in the merged local registry. Never touches the network.
 */
export function getLocalSelectorInfo(
  selector: string
): ISelectorInfo | undefined {
  return getLocalRegistry().get(normalizeSelector(selector))
}

/** Base URL for the Sourcify 4byte lookup (openchain.xyz-compatible API). */
const FOURBYTE_BATCH_LOOKUP_BASE =
  'https://api.4byte.sourcify.dev/signature-database/v1/lookup'

/** Max selectors per lookup request, to keep URLs comfortably short. */
const FOURBYTE_BATCH_SIZE = 50

const DEFAULT_SELECTOR_CACHE_RELATIVE_PATH = path.join(
  '.cache',
  'selector-signatures.json'
)

/**
 * Extracts selector → signature pairs from a 4byte/Sourcify lookup response.
 * Only the requested selectors are considered; anything malformed is ignored.
 */
export function parseFourByteBatchResponse(
  raw: unknown,
  selectors: string[]
): Map<string, string> {
  const map = new Map<string, string>()
  if (!isRecord(raw) || raw.ok !== true || !isRecord(raw.result)) return map
  const fnResults = raw.result.function
  if (!isRecord(fnResults)) return map
  for (const selector of selectors) {
    const key = normalizeSelector(selector)
    const entries = fnResults[key]
    if (!Array.isArray(entries)) continue
    // 4byte can return multiple (and colliding) signatures per selector; take
    // the first that actually hashes back to the requested selector.
    const match = entries.find(
      (entry): entry is { name: string } =>
        isRecord(entry) &&
        typeof entry.name === 'string' &&
        isVerifiedSelectorSignature(key, entry.name)
    )
    if (match) map.set(key, match.name)
  }
  return map
}

function readDiskCache(cachePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(cachePath)) return {}
    if (cachePath.includes('..') || path.isAbsolute(cachePath)) return {}
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
    if (!isRecord(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [selector, signature] of Object.entries(parsed))
      if (
        typeof signature === 'string' &&
        isVerifiedSelectorSignature(selector, signature)
      )
        out[normalizeSelector(selector)] = signature
    return out
  } catch {
    return {}
  }
}

function writeDiskCache(
  cachePath: string,
  entries: Record<string, string>
): void {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    const tmpPath = `${cachePath}.tmp`
    fs.writeFileSync(tmpPath, `${JSON.stringify(entries, null, 2)}\n`)
    fs.renameSync(tmpPath, cachePath)
  } catch (error) {
    consola.debug(`selector-registry: cache write skipped: ${error}`)
  }
}

// Selectors the 4byte API answered (or failed to answer) this run, per cache
// file — avoids refetching in-process; negatives are never persisted to disk.
const inMemoryFourByteResults = new Map<string, Map<string, string | null>>()

function getRunCache(cachePath: string): Map<string, string | null> {
  let cache = inMemoryFourByteResults.get(cachePath)
  if (!cache) {
    cache = new Map()
    inMemoryFourByteResults.set(cachePath, cache)
  }
  return cache
}

/**
 * Resolves selectors to signatures via the Sourcify 4byte API, batched into
 * as few requests as possible. Positive results are persisted to
 * .cache/selector-signatures.json (misses are only remembered in-process).
 * Network failures degrade to an empty/partial result — never a throw.
 */
export async function resolveSelectorsViaFourByte(
  selectors: string[],
  options?: {
    cachePath?: string
    fetcher?: (url: string) => Promise<Response>
  }
): Promise<Map<string, string>> {
  const cachePath =
    options?.cachePath ??
    process.env.SELECTOR_SIGNATURE_CACHE_PATH ??
    path.join(process.cwd(), DEFAULT_SELECTOR_CACHE_RELATIVE_PATH)
  const fetcher = options?.fetcher ?? ((url: string) => fetchWithTimeout(url))

  const normalized = [...new Set(selectors.map(normalizeSelector))]
  const resolved = new Map<string, string>()
  if (normalized.length === 0) return resolved

  const runCache = getRunCache(cachePath)
  const diskCache = readDiskCache(cachePath)
  const toFetch: string[] = []
  for (const selector of normalized) {
    const inRun = runCache.get(selector)
    if (typeof inRun === 'string') {
      resolved.set(selector, inRun)
      continue
    }
    if (inRun === null) continue // known miss this run
    const onDisk = diskCache[selector]
    if (onDisk) {
      resolved.set(selector, onDisk)
      runCache.set(selector, onDisk)
      continue
    }
    toFetch.push(selector)
  }

  if (toFetch.length === 0) return resolved

  const fetched = new Map<string, string>()
  for (let i = 0; i < toFetch.length; i += FOURBYTE_BATCH_SIZE) {
    const batch = toFetch.slice(i, i + FOURBYTE_BATCH_SIZE)
    try {
      const url = `${FOURBYTE_BATCH_LOOKUP_BASE}?function=${batch.join(
        ','
      )}&filter=true`
      const response = await fetcher(url)
      if (!response.ok) continue
      const raw: unknown = await response.json()
      for (const [selector, signature] of parseFourByteBatchResponse(
        raw,
        batch
      ))
        fetched.set(selector, signature)
    } catch (error) {
      consola.debug(`selector-registry: 4byte lookup failed: ${error}`)
    }
  }

  for (const selector of toFetch) {
    const signature = fetched.get(selector)
    runCache.set(selector, signature ?? null)
    if (signature) resolved.set(selector, signature)
  }

  if (fetched.size > 0)
    writeDiskCache(cachePath, {
      ...diskCache,
      ...Object.fromEntries(fetched),
    })

  return resolved
}
