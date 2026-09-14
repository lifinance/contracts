/**
 * The retry budget a read made at sign time is allowed to spend.
 *
 * `getTransportConfigFromRpcUrl` forwards each endpoint's own retry profile,
 * which is written for the deploy and broadcast paths: TronGrid's is 8 retries
 * on a 2s exponential backoff, and viem's delay is `~~(1 << count) * retryDelay`,
 * so a throttled TronGrid primary spends 2+4+…+256 = 510s of sleep plus nine
 * attempts at the transport timeout — roughly ten minutes for one `eth_getCode`.
 * A signer sits in front of these reads, and the codehash gate is the one that
 * refuses a signature, so an endpoint that needs nine attempts has to become a
 * non-answer quickly rather than a stall.
 *
 * Use this wherever a read happens while the operator waits. The deploy and
 * broadcast paths keep the endpoint's own profile, which is what it was tuned for.
 */

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
 * Resolves an endpoint to a transport config with a sign-time retry budget.
 *
 * Keeps everything `getTransportConfigFromRpcUrl` resolves about *reaching* the
 * endpoint — the rewritten URL and the credential and API-key headers, without
 * which a password-only endpoint answers 401 and that 401 is recorded as the
 * provider's answer — and replaces only the retry profile.
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
    retryDelay: SIGN_TIME_RETRY_DELAY_MS,
  }
}
