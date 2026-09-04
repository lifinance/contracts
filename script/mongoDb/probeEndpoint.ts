/**
 * Reachability probe for a single RPC endpoint.
 *
 * Two calls, not one: `eth_chainId` is answered by endpoints that then refuse the state reads
 * consumers actually make, and `eth_getCode` is the cheapest call that exercises that path.
 *
 * This establishes that an endpoint serves state reads from here, and nothing stronger. It does
 * not clear an endpoint for every method — a provider can serve `eth_getCode` and refuse
 * `eth_call` on the same chain — and reachability can differ by caller IP, so an endpoint that
 * passes here can still fail from a CI runner.
 */

import { hasApiCredentials } from './rpcEndpoints'

const PROBE_TIMEOUT_MS = 12_000
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

async function callRpc(
  url: string,
  method: string,
  params: unknown[]
): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return false
    const payload = (await response.json()) as {
      result?: unknown
      error?: unknown
    }
    return payload.error === undefined && payload.result !== undefined
  } catch {
    return false
  }
}

/** Attempts before an endpoint is called unreachable, and the pause between them. */
const PROBE_ATTEMPTS = 3
const RETRY_DELAY_MS = 1_500

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Whether probing this URL would put a secret on the wire in the clear. Anything that makes an
 * endpoint credentialed — basic auth, a key query parameter, a key-shaped path segment — is
 * readable to anyone on the path once the scheme is not https.
 */
function wouldLeakCredentials(url: string): boolean {
  try {
    return new URL(url).protocol !== 'https:' && hasApiCredentials(url)
  } catch {
    return false
  }
}

async function answersOnce(url: string): Promise<boolean> {
  if (!(await callRpc(url, 'eth_chainId', []))) return false
  return callRpc(url, 'eth_getCode', [ZERO_ADDRESS, 'latest'])
}

/**
 * Whether the endpoint answers both a chain-id read and a state read.
 *
 * The evidence is deliberately asymmetric: one success proves reachability, while "unreachable"
 * requires every attempt to fail. A single failed request is ordinary network weather, and acting
 * on it would demote a healthy endpoint — and, because callers rank on this, produce a different
 * answer on every run.
 */
export async function probeEndpoint(url: string): Promise<boolean> {
  // Reported as unreachable rather than thrown: one misconfigured endpoint must not abort a
  // fleet-wide sweep, and an endpoint we refuse to contact is not one we can rank as working.
  if (wouldLeakCredentials(url)) return false

  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS)
    if (await answersOnce(url)) return true
  }
  return false
}
