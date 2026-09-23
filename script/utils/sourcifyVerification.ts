/**
 * Sourcify verification check for a proxy (e.g. the LiFiDiamond) and every
 * implementation Sourcify resolves behind it (the facets).
 *
 * Mirrors `erc7730 lint --require-verified` from the ERC-7730 registry's pinned
 * fork (sourcifyeth/python-erc7730, `src/erc7730/common/client.py`): same
 * endpoint, same traversal of nested proxies, same reading of each response.
 * The registry rejects a descriptor deployment unless this check passes, so a
 * deployment that fails it must not be published.
 */

import { sleep } from './delay'
import { fetchWithTimeout } from './fetchWithTimeout'
import { mapWithConcurrency } from './mapWithConcurrency'

const SOURCIFY_API = 'https://sourcify.dev/server'
// Rate limiting (429) and 5xx are retried with exponential backoff: 2s, 4s,
// ... 128s (~4 minutes in total). Sourcify blocks an IP for
// ~30s after ~200 requests, longer when requests keep arriving during the
// block, and a full diamond sweep is thousands of requests, so the waits must
// outlast repeated blocks.
const MAX_ATTEMPTS = 8
const DEFAULT_RETRY_DELAY_MS = 2_000 // 2 seconds, doubled after each attempt
const IMPLEMENTATION_CONCURRENCY = 8 // facet lookups in flight per diamond

export interface ISourcifyContractRef {
  address: string
  name?: string
}

export type SourcifyVerificationResult =
  | { status: 'verified' }
  | { status: 'unsupported_chain' }
  | { status: 'unverified'; contracts: ISourcifyContractRef[] }

export interface ISourcifyCheckOptions {
  retryDelayMs?: number
}

interface ISourcifyContractResponse {
  proxyResolution?: {
    isProxy?: boolean
    implementations?: Array<{ address: string; name?: string }>
    proxyResolutionError?: { message?: string } | null
  } | null
}

type LookupResult =
  | { kind: 'verified'; implementations: ISourcifyContractRef[] }
  | { kind: 'not_found' }
  | { kind: 'unsupported_chain' }

async function readErrorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { customCode?: unknown }
    return typeof body.customCode === 'string' ? body.customCode : undefined
  } catch {
    return undefined
  }
}

async function fetchWithRetry(
  url: string,
  options: ISourcifyCheckOptions
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS

  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(url, { headers })
      if (res.status !== 429 && res.status < 500) return res
      lastError = `HTTP ${res.status} ${res.statusText}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs * 2 ** (attempt - 1))
  }
  throw new Error(
    `Sourcify request failed after ${MAX_ATTEMPTS} attempts (${lastError}): ${url}. ` +
      'On repeated 429s, wait a few minutes for the rate-limit block to lift and rerun.'
  )
}

async function lookupContract(
  chainId: number,
  address: string,
  options: ISourcifyCheckOptions
): Promise<LookupResult> {
  const url = `${SOURCIFY_API}/v2/contract/${chainId}/${address}?fields=proxyResolution`
  const res = await fetchWithRetry(url, options)

  if (res.status === 404) return { kind: 'not_found' }
  if (res.status === 400) {
    const code = await readErrorCode(res)
    if (code === 'unsupported_chain') return { kind: 'unsupported_chain' }
    throw new Error(
      `Sourcify rejected ${url}: HTTP 400 (${code ?? 'no error code'})`
    )
  }
  if (!res.ok)
    throw new Error(`Sourcify returned HTTP ${res.status} for ${url}`)

  const body = (await res.json()) as ISourcifyContractResponse
  const resolution = body.proxyResolution
  // Proxy resolution runs at request time; a failure is not evidence that the
  // contract is a plain non-proxy, so it cannot count as verified.
  if (resolution?.proxyResolutionError)
    throw new Error(
      `Sourcify could not resolve whether ${address} on chain ${chainId} is a proxy: ` +
        `${resolution.proxyResolutionError.message ?? 'unknown error'}`
    )
  if (!resolution?.isProxy) return { kind: 'verified', implementations: [] }
  return {
    kind: 'verified',
    implementations: (resolution.implementations ?? []).map((i) => ({
      address: i.address,
      ...(i.name ? { name: i.name } : {}),
    })),
  }
}

/**
 * Checks that Sourcify verifies `address` on `chainId` and, if Sourcify
 * resolves it as a proxy, every implementation behind it (recursively).
 * @param chainId - EIP-155 chain ID
 * @param address - Contract address (the diamond)
 * @param options - Optional retry delay
 * @returns `verified`, `unsupported_chain`, or `unverified` with every
 *   contract Sourcify does not know (the root, or the unverified implementations)
 * @throws On responses that do not settle the question — rate limiting or
 *   server errors after retries, a failed proxy resolution, an unexpected 400.
 *   Callers must not read these as "unverified", or a transient Sourcify fault
 *   would drop a live deployment from the output.
 */
export async function checkSourcifyVerification(
  chainId: number,
  address: string,
  options: ISourcifyCheckOptions = {}
): Promise<SourcifyVerificationResult> {
  const root = await lookupContract(chainId, address, options)
  if (root.kind === 'unsupported_chain') return { status: 'unsupported_chain' }
  if (root.kind === 'not_found')
    return { status: 'unverified', contracts: [{ address }] }

  const visited = new Set([address.toLowerCase()])
  const unverified: ISourcifyContractRef[] = []
  let pending = root.implementations

  while (pending.length > 0) {
    const level: ISourcifyContractRef[] = []
    for (const c of pending) {
      const key = c.address.toLowerCase()
      if (visited.has(key)) continue
      visited.add(key)
      level.push(c)
    }

    const results = await mapWithConcurrency(
      level,
      IMPLEMENTATION_CONCURRENCY,
      (c) => lookupContract(chainId, c.address, options)
    )

    pending = []
    results.forEach((result, i) => {
      const contract = level[i] as ISourcifyContractRef
      if (result.kind === 'verified') pending.push(...result.implementations)
      else unverified.push(contract)
    })
  }

  return unverified.length === 0
    ? { status: 'verified' }
    : { status: 'unverified', contracts: unverified }
}
