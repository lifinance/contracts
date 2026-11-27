/**
 * The retry budget a read made at sign time is allowed to spend.
 *
 * Import this wherever a read happens while the operator waits; the deploy and
 * broadcast paths keep the endpoint's own profile, which is what it was tuned for.
 */

import { isTronGridHost } from '../../mongoDb/rpcEndpoints'
import { getTransportConfigFromRpcUrl } from '../../utils/viemScriptHelpers'

/**
 * Two retries, not one.
 *
 * These reads are single-endpoint, and a failure is consequential: on a network
 * with no configured fallback, a failed codehash read blocks the signature. One
 * retry would turn a single 429 into a refusal to sign, which is the opposite
 * failure from the one this cap exists to prevent.
 */
export const SIGN_TIME_RETRY_COUNT = 2

/**
 * 1 second, rather than viem's 150 ms default.
 *
 * The retry exists for a throttled endpoint, and 150 ms after a 429 is still
 * inside the window that produced it. Two retries at this spacing cost at most
 * 1+2 = 3s of backoff.
 */
export const SIGN_TIME_RETRY_DELAY_MS = 1_000

/**
 * 6 seconds on TronGrid.
 *
 * A throttled TronGrid client is suspended for 5s (its 429 body says so), so
 * both retries at the default spacing land inside the suspension and the read
 * fails. The first retry at this spacing clears it; the two cost at most
 * 6+12 = 18s of backoff.
 */
export const TRONGRID_SIGN_TIME_RETRY_DELAY_MS = 6_000 // 6 seconds

const retryDelayFor = (url: string): number => {
  try {
    return isTronGridHost(new URL(url).hostname)
      ? TRONGRID_SIGN_TIME_RETRY_DELAY_MS
      : SIGN_TIME_RETRY_DELAY_MS
  } catch {
    return SIGN_TIME_RETRY_DELAY_MS
  }
}

/**
 * Resolves an endpoint to a transport config with a sign-time retry budget.
 *
 * Keeps everything `getTransportConfigFromRpcUrl` resolves about *reaching* the
 * endpoint — the rewritten URL and the credential and API-key headers, without
 * which a password-only endpoint answers 401 and that 401 is recorded as the
 * provider's answer — and replaces only the retry profile.
 *
 * That profile is written for the deploy and broadcast paths: TronGrid's is 8
 * retries on a 2s exponential backoff, and viem's delay is
 * `~~(1 << count) * retryDelay`, so a throttled TronGrid primary spends
 * 2+4+…+256 = 510s of sleep plus nine attempts at the transport timeout —
 * roughly ten minutes for one `eth_getCode`, with the codehash gate's signature
 * refusal waiting behind it.
 *
 * The replacement is unconditional, not TronGrid-only: every network's
 * sign-time reads get this budget in place of viem's own 3 retries at 150ms,
 * with TronGrid's spacing widened to outlast its suspension.
 *
 * @param rpcUrl - The endpoint to read from.
 * @returns The transport config, with the retry profile capped.
 * @throws Whatever `getTransportConfigFromRpcUrl` throws, e.g. credentials over cleartext http.
 */
export const getSignTimeTransportConfig = (
  rpcUrl: string
): {
  url: string
  fetchOptions?: { headers: Record<string, string> }
  retryCount: number
  retryDelay: number
} => {
  const { url, fetchOptions } = getTransportConfigFromRpcUrl(rpcUrl)
  return {
    url,
    ...(fetchOptions ? { fetchOptions } : {}),
    retryCount: SIGN_TIME_RETRY_COUNT,
    retryDelay: retryDelayFor(url),
  }
}
