/**
 * Read-only viem clients for Safe contract queries without a signing wallet.
 */

import {
  createPublicClient,
  fallback,
  http,
  type PublicClient,
  type Transport,
} from 'viem'

import { getViemChainForNetworkName } from '../../utils/viemScriptHelpers'

import { getSignTimeTransportConfig } from './sign-time-transport'

/**
 * Builds one capped transport per endpoint, in the chain's priority order.
 *
 * `getFallbackTransportForChain` would fan out too, but it keeps each
 * endpoint's own retry profile — TronGrid's is 8 retries on a 2s exponential
 * backoff, which is minutes of sleep on a read the signer is waiting for. The
 * fan-out and the sign-time cap are both required here, and no shared helper
 * carries both.
 *
 * @param endpoints - The endpoints to try, in priority order.
 * @param options - `signal` bounds every request each transport makes.
 * @returns A single transport when only one endpoint is usable, else a fallback over all of them.
 * @throws When no endpoint is usable, which the caller records as a failed read.
 */
const buildCappedFallbackTransport = (
  endpoints: readonly string[],
  options?: { signal?: AbortSignal }
): Transport => {
  const transports = endpoints.flatMap((endpointUrl) => {
    let config: ReturnType<typeof getSignTimeTransportConfig>
    try {
      config = getSignTimeTransportConfig(endpointUrl)
    } catch {
      // An endpoint this chain cannot use, which the remaining ones are there
      // to cover. Letting one of them abort the chain takes down a network
      // whose other endpoints are healthy.
      return []
    }
    const { url, fetchOptions, retryCount, retryDelay } = config
    const mergedFetchOptions = {
      ...(fetchOptions ?? {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    }
    return [
      http(url, {
        ...(Object.keys(mergedFetchOptions).length
          ? { fetchOptions: mergedFetchOptions }
          : {}),
        retryCount,
        retryDelay,
      }),
    ]
  })

  const [only] = transports
  if (!only) throw new Error('no usable RPC endpoint')
  return transports.length === 1 ? only : fallback(transports)
}

/**
 * Builds a read-only viem client for a network, honoring an optional RPC
 * override.
 *
 * Without an override the client reads through every endpoint the network has,
 * in priority order — the transport the executability gate already uses. These
 * reads decide whether a network can be signed at all, so reading them through
 * the primary alone made a network with a throttled primary and a healthy spare
 * unusable while the gates read it fine, and a signer cannot act on a network
 * the run disagrees with itself about.
 *
 * Either path resolves the endpoint's own credentials into headers, which is
 * what keeps a `user:pass@` endpoint authenticated: viem's own branch is
 * `if (url.username)`, so a password-only endpoint would be queried
 * unauthenticated and answer 401.
 *
 * @param network - The network key, as `config/networks.json` spells it.
 * @param rpcUrl - One endpoint to use instead of the configured set.
 * @param options - `signal` bounds every request the client makes, retries
 *   included; without it an endpoint that never answers costs viem's full retry
 *   budget before the caller hears about it.
 * @returns A public client for read calls only.
 */
export function buildReadOnlyClient(
  network: string,
  rpcUrl?: string,
  options?: { signal?: AbortSignal }
): PublicClient {
  const chain = getViemChainForNetworkName(network)

  return createPublicClient({
    chain,
    transport: buildCappedFallbackTransport(
      rpcUrl ? [rpcUrl] : chain.rpcUrls.default.http,
      options
    ),
  }) as PublicClient
}
