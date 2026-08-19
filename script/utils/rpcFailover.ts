/**
 * Capability-aware selection of an RPC endpoint from several candidate sources.
 *
 * Import this when a script needs to pick a usable endpoint for a network rather than
 * trusting a single configured URL. Endpoints are ranked by the capabilities they are
 * observed to have, so an endpoint that answers `eth_blockNumber` but cannot serve
 * `eth_feeHistory` loses to one that can.
 *
 * All helpers here are transport-only and hold no network config; `resolveRpcUrl.ts`
 * supplies the candidates and owns the MongoDB lookup.
 */

import { fetchWithTimeout } from './fetchWithTimeout'

/** Where a candidate endpoint came from, in ascending order of trust. */
export type RpcSource = 'networksJson' | 'mongo' | 'env'

export interface IRpcCandidate {
  url: string
  source: RpcSource
  priority: number
}

export interface IRpcProbe {
  url: string
  live: boolean
  feeHistory: boolean
  /** Block carries both `baseFeePerGas` and `mixHash`, the pair forge's 1559 path deserializes. */
  eip1559Block: boolean
  gasPrice: boolean
}

export interface IRpcSelection {
  url: string
  source: RpcSource
  /** Union over live candidates: a capability absent here is a chain property, not a defect. */
  chainCapabilities: { feeHistory: boolean; eip1559Block: boolean }
}

/** How a forge failure constrains endpoint switching. */
export type ForgeFailureClass = 'preBroadcast' | 'postBroadcast' | 'unknown'

const SOURCE_TRUST: Record<RpcSource, number> = {
  env: 2,
  mongo: 1,
  networksJson: 0,
}

const PROBE_TIMEOUT_MS = 5_000 // 5 seconds; a candidate slower than this is not worth deploying through

/**
 * Reduces an RPC URL to scheme and host.
 *
 * RPC URLs embed API keys in their path or query string, so this is the only form that
 * may be logged.
 *
 * @param url - Any candidate URL
 * @returns `scheme://host[:port]`, or a placeholder when the input cannot be parsed
 */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return '<unparseable-url>'
  }
}

/**
 * Canonical form used to decide whether two candidate URLs are the same endpoint.
 * Returns null for anything that is not an http(s) URL.
 */
function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    const path = parsed.pathname.replace(/\/+$/, '')
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${path}${
      parsed.search
    }`
  } catch {
    return null
  }
}

/**
 * Builds the deduplicated candidate list for a network.
 *
 * @param input.envUrl - Value of `ETH_NODE_URI_<NETWORK>`, if set
 * @param input.mongoRpcs - Entries from the `RpcEndpoints` collection. `isActive` is
 *   deliberately not consulted: it is unset on every document in the collection.
 * @param input.networksJsonUrl - `rpcUrl` from `config/networks.json`
 * @param input.exclude - Endpoints already known to have failed this run
 * @returns Candidates ordered by trust, then descending priority. Unparseable and
 *   non-http entries are dropped rather than throwing.
 */
export function collectCandidates(input: {
  envUrl?: string
  mongoRpcs?: { url: string; priority: number }[]
  networksJsonUrl?: string
  exclude?: string[]
}): IRpcCandidate[] {
  const excluded = new Set(
    (input.exclude ?? [])
      .map(normalizeUrl)
      .filter((value): value is string => value !== null)
  )

  const ordered: IRpcCandidate[] = [
    ...(input.envUrl
      ? [{ url: input.envUrl, source: 'env' as const, priority: 0 }]
      : []),
    ...[...(input.mongoRpcs ?? [])]
      .sort((a, b) => b.priority - a.priority)
      .map((entry) => ({
        url: entry.url,
        source: 'mongo' as const,
        priority: entry.priority,
      })),
    ...(input.networksJsonUrl
      ? [
          {
            url: input.networksJsonUrl,
            source: 'networksJson' as const,
            priority: 0,
          },
        ]
      : []),
  ]

  const seen = new Set<string>()
  const result: IRpcCandidate[] = []
  for (const candidate of ordered) {
    const key = normalizeUrl(candidate.url)
    if (key === null || excluded.has(key) || seen.has(key)) continue
    seen.add(key)
    result.push(candidate)
  }
  return result
}

interface IJsonRpcOutcome {
  ok: boolean
  result?: unknown
}

async function callJsonRpc(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs: number
): Promise<IJsonRpcOutcome> {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      },
      timeoutMs
    )
    if (!response.ok) return { ok: false }
    const payload = (await response.json()) as {
      result?: unknown
      error?: unknown
    }
    if (payload.error !== undefined) return { ok: false }
    return { ok: true, result: payload.result }
  } catch {
    // Transport errors are swallowed on purpose: their message quotes the full URL,
    // API key included, and must never reach a log.
    return { ok: false }
  }
}

/**
 * Probes a single endpoint for the capabilities a deploy depends on.
 *
 * Never throws and never surfaces the transport error, which would carry the URL.
 *
 * @param url - Endpoint to probe
 * @param timeoutMs - Per-call timeout; defaults to 5s
 * @returns Capability flags. An endpoint that fails `eth_blockNumber` is reported dead
 *   with every other capability false.
 */
export async function probeRpcEndpoint(
  url: string,
  timeoutMs: number = PROBE_TIMEOUT_MS
): Promise<IRpcProbe> {
  const dead: IRpcProbe = {
    url,
    live: false,
    feeHistory: false,
    eip1559Block: false,
    gasPrice: false,
  }

  const liveness = await callJsonRpc(url, 'eth_blockNumber', [], timeoutMs)
  if (!liveness.ok) return dead

  const [feeHistory, block, gasPrice] = await Promise.all([
    callJsonRpc(url, 'eth_feeHistory', ['0x1', 'latest', []], timeoutMs),
    callJsonRpc(url, 'eth_getBlockByNumber', ['latest', false], timeoutMs),
    callJsonRpc(url, 'eth_gasPrice', [], timeoutMs),
  ])

  const header = block.ok
    ? (block.result as Record<string, unknown> | null)
    : null

  return {
    url,
    live: true,
    feeHistory: feeHistory.ok,
    eip1559Block:
      header?.baseFeePerGas !== undefined && header?.mixHash !== undefined,
    gasPrice: gasPrice.ok,
  }
}

const CAPABILITY_KEYS = ['feeHistory', 'eip1559Block', 'gasPrice'] as const

/**
 * Picks the best endpoint from probed candidates.
 *
 * Ranking is by observed capabilities, then trust, then priority. Capabilities are
 * compared against what the other candidates managed, never against a fixed
 * requirement: when a whole chain lacks one (moonbeam and fuse have no `mixHash` on
 * any endpoint), every candidate ties and selection falls through to trust — so such a
 * chain still gets an endpoint instead of a hard failure.
 *
 * @param candidates - Candidates in trust order
 * @param probes - Probe results, matched to candidates by URL
 * @returns The winner plus the chain's capability union, or null if none is live
 */
export function selectBestCandidate(
  candidates: IRpcCandidate[],
  probes: IRpcProbe[]
): IRpcSelection | null {
  const probeByUrl = new Map(probes.map((probe) => [probe.url, probe]))

  const scored = candidates
    .map((candidate) => ({
      candidate,
      probe: probeByUrl.get(candidate.url),
    }))
    .filter(
      (entry): entry is { candidate: IRpcCandidate; probe: IRpcProbe } =>
        entry.probe !== undefined && entry.probe.live
    )

  if (scored.length === 0) return null

  const capabilityCount = (probe: IRpcProbe) =>
    CAPABILITY_KEYS.filter((key) => probe[key]).length

  const best = scored.reduce((winner, entry) => {
    const byCapability =
      capabilityCount(entry.probe) - capabilityCount(winner.probe)
    if (byCapability !== 0) return byCapability > 0 ? entry : winner

    const byTrust =
      SOURCE_TRUST[entry.candidate.source] -
      SOURCE_TRUST[winner.candidate.source]
    if (byTrust !== 0) return byTrust > 0 ? entry : winner

    return entry.candidate.priority > winner.candidate.priority ? entry : winner
  })

  return {
    url: best.candidate.url,
    source: best.candidate.source,
    chainCapabilities: {
      feeHistory: scored.some((entry) => entry.probe.feeHistory),
      eip1559Block: scored.some((entry) => entry.probe.eip1559Block),
    },
  }
}

// A transaction that reached the mempool pins the endpoint: a different backend has a
// different view of it, which is how switching mid-sequence produced a stuck pending
// nonce on moonbeam during the FeeForwarder v2.0.0 rollout.
const POST_BROADCAST_SIGNATURES = [
  /already known/i,
  /nonce too low/i,
  /replacement transaction underpriced/i,
  /already imported/i,
]

const PRE_BROADCAST_SIGNATURES = [
  /missing field `?mixHash`?/i,
  /failed to get eip-?1559 fees/i,
  /-32601/,
  /method .* does not exist/i,
  /method not found/i,
  /connection refused/i,
  /dns error/i,
  /operation timed out/i,
  /\btimed out\b/i,
  /error sending request/i,
  /no json output received/i,
]

/**
 * Classifies a failed forge run by whether a transaction may already be in flight.
 *
 * @param output - Combined stderr and raw return data from the run
 * @returns `postBroadcast` if anything suggests a transaction reached the mempool,
 *   `preBroadcast` for a recognised connection or fee-estimation failure, otherwise
 *   `unknown`. Callers must only switch endpoints on `preBroadcast`.
 */
export function classifyForgeFailure(output: string): ForgeFailureClass {
  if (POST_BROADCAST_SIGNATURES.some((pattern) => pattern.test(output)))
    return 'postBroadcast'
  if (PRE_BROADCAST_SIGNATURES.some((pattern) => pattern.test(output)))
    return 'preBroadcast'
  return 'unknown'
}

/**
 * Resolves the best endpoint for a network by probing all candidates concurrently.
 *
 * @param input.envUrl - Value of `ETH_NODE_URI_<NETWORK>`, if set
 * @param input.mongoRpcs - Entries from the `RpcEndpoints` collection
 * @param input.networksJsonUrl - `rpcUrl` from `config/networks.json`
 * @param input.exclude - Endpoints already known to have failed this run
 * @param input.timeoutMs - Per-probe timeout
 * @returns The selected endpoint, or null when no candidate is usable
 */
export async function resolveEndpoint(input: {
  envUrl?: string
  mongoRpcs?: { url: string; priority: number }[]
  networksJsonUrl?: string
  exclude?: string[]
  timeoutMs?: number
}): Promise<IRpcSelection | null> {
  const candidates = collectCandidates(input)
  if (candidates.length === 0) return null

  const probes = await Promise.all(
    candidates.map((candidate) =>
      probeRpcEndpoint(candidate.url, input.timeoutMs)
    )
  )
  return selectBestCandidate(candidates, probes)
}
