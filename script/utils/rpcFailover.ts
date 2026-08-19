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

export interface IRpcCapabilities {
  feeHistory: boolean
  /** Block carries both `baseFeePerGas` and `mixHash`, the pair forge's 1559 path deserializes. */
  eip1559Block: boolean
  gasPrice: boolean
}

export interface IRpcProbe extends IRpcCapabilities {
  url: string
  live: boolean
}

export interface IRpcSelection {
  url: string
  source: RpcSource
  /** Capabilities of the selected endpoint. Use this to decide how to transact through it. */
  capabilities: IRpcCapabilities
  /**
   * Union over live candidates. A capability false here is absent chain-wide, which
   * makes it a chain property rather than a defect of any one endpoint. Never use this
   * to decide how to transact — it may describe an endpoint that was not selected.
   */
  chainCapabilities: IRpcCapabilities
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
 * may be logged. Note the limit of that guarantee: providers that key on the hostname
 * itself (QuickNode) still expose their endpoint identifier here.
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
 *
 * Credentials are part of the identity: an authenticated and an anonymous URL for the
 * same host are different endpoints, and collapsing them would drop the only candidate
 * that can authenticate. Query parameters are sorted so that the same endpoint written
 * with a different parameter order still matches an exclusion.
 *
 * @returns The canonical key, or null for anything that is not an http(s) URL
 */
function normalizeUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

    // Sorted over the RAW pairs: decoding would make "AB+CD" and "AB%20CD" — two
    // genuinely different API keys — look like the same endpoint.
    const query = parsed.search
      .replace(/^\?/, '')
      .split('&')
      .filter(Boolean)
      .sort()
      .join('&')
    const credentials = parsed.username
      ? `${parsed.username}:${parsed.password}@`
      : ''
    const path = parsed.pathname.replace(/\/+$/, '')

    return `${
      parsed.protocol
    }//${credentials}${parsed.host.toLowerCase()}${path}${
      query ? `?${query}` : ''
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
    // A rate limiter answering 200 with `{"message":"Too Many Requests"}` carries no
    // error key either, so a present, non-null result is what makes a call successful.
    if (payload.error !== undefined) return { ok: false }
    if (payload.result === undefined || payload.result === null)
      return { ok: false }
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

  // A field present but null fails forge's deserialization exactly like a missing one,
  // so only a real hex string counts as support.
  const hasHexField = (field: string) => typeof header?.[field] === 'string'

  return {
    url,
    live: true,
    feeHistory: feeHistory.ok,
    eip1559Block: hasHexField('baseFeePerGas') && hasHexField('mixHash'),
    gasPrice: gasPrice.ok,
  }
}

const CAPABILITY_KEYS = ['feeHistory', 'eip1559Block', 'gasPrice'] as const

const capabilitiesOf = (probe: IRpcProbe): IRpcCapabilities => ({
  feeHistory: probe.feeHistory,
  eip1559Block: probe.eip1559Block,
  gasPrice: probe.gasPrice,
})

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
 * @returns The winner with its own capabilities and the chain's capability union, or
 *   null if no candidate is live
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
    capabilities: capabilitiesOf(best.probe),
    chainCapabilities: {
      feeHistory: scored.some((entry) => entry.probe.feeHistory),
      eip1559Block: scored.some((entry) => entry.probe.eip1559Block),
      gasPrice: scored.some((entry) => entry.probe.gasPrice),
    },
  }
}

/**
 * Paths forge prints for a broadcast it actually performed. A dry run writes the same
 * file name under a `dry-run/` directory, which is why the path is inspected rather
 * than matched as a bare string.
 */
const BROADCAST_ARTIFACT_PATTERNS = [
  /"transactions"\s*:\s*"([^"]+)"/gi,
  /transactions saved to:\s*(\S+)/gi,
]

function mentionsRealBroadcastArtifact(output: string): boolean {
  for (const pattern of BROADCAST_ARTIFACT_PATTERNS) {
    pattern.lastIndex = 0
    let match = pattern.exec(output)
    while (match !== null) {
      const path = match[1] ?? ''
      // A dry run writes the same file name one directory deeper, under `dry-run/`.
      // Only that final segment counts: a checkout living under some unrelated
      // `dry-run` directory would otherwise hide a real broadcast.
      const isDryRun = /(^|\/)dry-run\/[^/]+$/.test(path)
      if (path && !isDryRun) return true
      match = pattern.exec(output)
    }
  }
  return false
}

/**
 * Evidence that forge got as far as submitting a transaction, taken from observed
 * `forge script --broadcast --slow --json` output rather than from its documentation:
 * under `--json` the human-readable progress lines are suppressed, so the markers that
 * survive are the send/poll errors and the broadcast artifact path.
 *
 * Once any of these appear a transport failure is ambiguous — the node may have
 * accepted the transaction and only the response was lost — so the endpoint is pinned.
 */
const BROADCAST_EVIDENCE = [
  /failed to send transaction/i,
  /transactions were discarded by the rpc node/i,
  /failed to poll/i,
  /onchain execution complete/i,
  // Progress lines, suppressed by --json but present on the callers that omit it.
  // A simulation prints "SIMULATION COMPLETE" instead, so these do not match a dry run.
  /sending transactions?\b/i,
  /waiting for receipts?/i,
  /sequence #/i,
]

// A transaction that reached the mempool pins the endpoint: a different backend has a
// different view of it, which is how switching mid-sequence produced a stuck pending
// nonce on moonbeam during the FeeForwarder v2.0.0 rollout.
const POST_BROADCAST_SIGNATURES = [
  /already known/i,
  /known transaction/i,
  /transaction_already_known/i,
  /already in the pool/i,
  /transaction already exists/i,
  /already imported/i,
  /nonce too low/i,
  /nonce too high/i,
  /oldnonce/i,
  /underpriced/i,
]

/**
 * Failures that provably precede submission. Each is a string forge was observed to
 * emit: the fee-estimation errors come from an endpoint without `eth_feeHistory`, and
 * the header-validation error from a chain whose blocks carry no `mixHash`.
 */
const PRE_BROADCAST_SIGNATURES = [
  /failed to get eip-?1559 fees/i,
  /header validation error/i,
  /prevrandao. not set/i,
  /failed to deploy script/i,
  /missing field `?mixHash`?/i,
  /-32601/,
  /the method .* does not exist/i,
  /method not found/i,
  /connection refused/i,
  /dns error/i,
  /operation timed out/i,
  /\btimed out\b/i,
  /error sending request/i,
]

/**
 * Classifies a failed forge run by whether a transaction may already be in flight.
 *
 * Transport failures are only safe to fail over from when nothing suggests a broadcast
 * happened: `error sending request` while submitting a signed transaction is the
 * canonical ambiguous case, because the node may have accepted it and lost the reply.
 * Broadcast evidence therefore outranks every transport pattern.
 *
 * @param output - Combined stderr and unextracted stdout from the run. Passing forge's
 *   JSON-extracted stdout instead would drop the broadcast markers entirely.
 * @returns `postBroadcast` if a transaction may have reached the mempool,
 *   `preBroadcast` for a recognised failure that provably precedes submission,
 *   otherwise `unknown`. Callers must only switch endpoints on `preBroadcast`.
 */
export function classifyForgeFailure(output: string): ForgeFailureClass {
  if (mentionsRealBroadcastArtifact(output)) return 'postBroadcast'
  if (BROADCAST_EVIDENCE.some((pattern) => pattern.test(output)))
    return 'postBroadcast'
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
